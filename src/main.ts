import chalk from "chalk";
import { existsSync, promises } from "fs";
import md5 from "md5";
import {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  CloudFrontClient,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";

import { Asset, retrieveAssets, writeAsset } from "./assets";
import { confirm, writeLine } from "./console";
import { LOCAL_BUILD_DIRECTORY } from "./constants";

const S3_AWS_REGION = ""; // TODO
const S3_BUCKET_NAME = ""; // TODO
const CLOUDFRONT_AWS_REGION = ""; // TODO
const CLOUDFRONT_ID = ""; // TODO

async function shouldUploadFile(
  client: S3Client,
  key: string,
  eTag: string
): Promise<boolean> {
  try {
    const head = await client.send(
      new HeadObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: key,
      })
    );

    return head.ETag !== eTag;
  } catch (e) {
    if (e.name === "NotFound") {
      return true;
    }

    console.log(e);
    return true;
  }
}

async function confirmDeployReady(): Promise<boolean> {
  const wantsToDeploy = await confirm(
    "Would you like to deploy the latest build in the build directory?"
  );
  if (!wantsToDeploy) {
    return false;
  }

  const hasRunSynchronize = await confirm(
    `Have you run ${chalk.bold("yarn synchronize")} already?`
  );
  if (!hasRunSynchronize) {
    return false;
  }

  return true;
}

function getRelativeTime(ms: Date): { label: string; isRecent: boolean } {
  const duration = Date.now() - ms.valueOf();
  const ONE_SECOND = 1000;
  const ONE_MINUTE = 60 * ONE_SECOND;
  const ONE_HOUR = 60 * ONE_MINUTE;
  const ONE_DAY = 24 * ONE_HOUR;

  if (duration < ONE_SECOND) {
    return { isRecent: true, label: "just now" };
  }

  if (duration < ONE_MINUTE) {
    const numSecs = Math.round(duration / ONE_SECOND);
    return {
      isRecent: true,
      label: numSecs === 1 ? "1 second ago" : `${numSecs} seconds ago`,
    };
  }

  if (duration < ONE_HOUR) {
    const numMinutes = Math.round(duration / ONE_MINUTE);
    return {
      isRecent: numMinutes < 3,
      label: numMinutes === 1 ? "1 minute ago" : `${numMinutes} minutes ago`,
    };
  }

  if (duration < ONE_DAY) {
    const numHours = Math.round(duration / ONE_HOUR);
    return {
      isRecent: false,
      label: numHours === 1 ? "1 hour ago" : `${numHours} hours ago`,
    };
  }

  const numDays = Math.round(duration / ONE_DAY);
  return {
    isRecent: false,
    label: numDays === 1 ? "1 day ago" : `${numDays} days ago`,
  };
}

async function main() {
  // Intro into the tool
  writeLine(chalk.bold("Personal Website Release Tool"));
  writeLine("Deploys Alec's personal website to S3");
  writeLine();

  // Output information about the last build
  const doesBuildDirectoryExist = existsSync(LOCAL_BUILD_DIRECTORY);

  writeLine(`${chalk.bold("Build directory:")} ${LOCAL_BUILD_DIRECTORY}`);
  if (!doesBuildDirectoryExist) {
    writeLine(
      `${chalk.red("Directory does not exist.")} Run ${chalk.bold(
        "yarn build"
      )} to generate a build.`
    );
    process.exit(1);
  }

  const buildDirLastModified = (await promises.stat(LOCAL_BUILD_DIRECTORY))
    .mtime;
  const relativeLastModified = getRelativeTime(buildDirLastModified);
  const lastModifiedChalk = relativeLastModified.isRecent
    ? chalk.white
    : chalk.red;

  writeLine(
    lastModifiedChalk(
      `${chalk.bold("Last modified:")} ${buildDirLastModified.toString()} (${
        relativeLastModified.label
      })`
    )
  );

  writeLine();

  // Perform the pre-deploy confirmation checks
  const readyToDeploy = await confirmDeployReady();
  if (!readyToDeploy) {
    return;
  }

  const assets = await retrieveAssets();

  // Perform the initial upload to S3
  writeLine(chalk.bold("Beginning S3 Upload."));
  const s3Client = new S3Client({ region: S3_AWS_REGION });
  const uploadedAssets: Asset[] = [];
  for (const asset of assets) {
    // If this file is ignored, write it out and then move on
    if (asset.isIgnored) {
      writeAsset(asset, "ignored");
      continue;
    }

    // Read the current contents of the file
    const contents = await asset.getContents();

    // Compute the ETag, which for PutObject on AWS is the MD5 hash of the Body
    // NOTE: AWS stores it as a string wrapped in double quotes
    const eTag = `"${md5(contents)}"`;

    // Determine if we should upload the file right now
    const shouldUpload = await shouldUploadFile(
      s3Client,
      asset.bucketKey,
      eTag
    );
    if (!shouldUpload) {
      writeAsset(asset, "skipped");
      continue;
    }

    // Upload the file
    writeAsset(asset, "uploading");
    try {
      await s3Client.send(
        new PutObjectCommand({
          ACL: "public-read",
          Body: contents,
          Bucket: S3_BUCKET_NAME,
          CacheControl: "max-age=315360000, no-transform, public",
          ContentType: asset.contentType,
          Key: asset.bucketKey,
        })
      );

      writeAsset(asset, "uploaded");
      uploadedAssets.push(asset);
    } catch {
      writeAsset(asset, "error");
      return; // Stop the process
    }
  }

  // Add a summary for the uploads
  writeLine();
  writeLine(
    `${chalk.bold("S3 Upload Complete.")} ${uploadedAssets.length} ${
      uploadedAssets.length === 1 ? "asset" : "assets"
    } uploaded.`
  );
  if (uploadedAssets.length) {
    uploadedAssets.forEach((asset): void => {
      writeLine(` • ${asset.bucketKey}`);
    });
    writeLine();
  }

  // Invalidate Cloudfront
  if (uploadedAssets.length) {
    writeLine(chalk.bold("Beginning Cloudfront invalidation."));

    const cloudfrontClient = new CloudFrontClient({
      region: CLOUDFRONT_AWS_REGION,
    });

    try {
      const invalidation = await cloudfrontClient.send(
        new CreateInvalidationCommand({
          DistributionId: CLOUDFRONT_ID,
          InvalidationBatch: {
            CallerReference: Date.now().toString(),
            Paths: {
              Items: uploadedAssets.map((asset) => `/${asset.bucketKey}`),
              Quantity: uploadedAssets.length,
            },
          },
        })
      );

      if (!invalidation.Invalidation) {
        console.error(invalidation);
        throw new Error("Created invalidation, but didn't define Invalidation");
      }

      writeLine(
        `${chalk.bold("Invalidation success.")} ${invalidation.Invalidation.Id}`
      );
    } catch (e) {
      console.error(e);
    }
  } else {
    writeLine(
      `${chalk.bold(
        "Skipping Cloudfront invalidation."
      )} No files were uploaded.`
    );
  }
}

main();
