import { AwsClient } from "aws4fetch";

/**
 * SigV4 presigned PUT URLs for the R2 S3 endpoint (mvp-design.md sections
 * 10.4 and 11.3, and the Cloudflare aws4fetch example).
 *
 * Exactly one object key and one Content-Type are signed per URL: the
 * Content-Type header participates in the signature (X-Amz-SignedHeaders),
 * so R2 rejects a PUT that changes either. Expiry is query-signed via
 * X-Amz-Expires.
 */

export interface PresignPutParams {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
  objectKey: string;
  contentType: string;
  expiresSeconds: number;
}

export async function createPresignedPutUrl(params: PresignPutParams): Promise<string> {
  const client = new AwsClient({
    accessKeyId: params.accessKeyId,
    secretAccessKey: params.secretAccessKey,
    service: "s3",
    region: "auto",
  });

  const url = new URL(
    `https://${params.accountId}.r2.cloudflarestorage.com/${params.bucketName}/${params.objectKey}`,
  );
  url.searchParams.set("X-Amz-Expires", String(params.expiresSeconds));

  const signed = await client.sign(
    new Request(url, {
      method: "PUT",
      headers: { "Content-Type": params.contentType },
    }),
    // allHeaders forces Content-Type into X-Amz-SignedHeaders (aws4fetch
    // skips it by default), so R2 rejects a PUT with a different type.
    { aws: { signQuery: true, allHeaders: true } },
  );
  return signed.url;
}
