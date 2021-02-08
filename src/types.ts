export interface PayloadMeta {
    S3Payload?: S3PayloadMeta;
}

export interface S3PayloadMeta {
    Id: string;
    Bucket: string;
    Key: string;
    Location: string;
}

export interface SqsExtendedPayloadMeta {
    s3BucketName: string;
    s3Key: string;
}
