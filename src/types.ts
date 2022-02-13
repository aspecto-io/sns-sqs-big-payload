import { AMAZON_EXTENDED_CLIENT_PAYLOAD_OFFLOADING_REFERENCE } from './constants';

export interface PayloadMeta {
    S3Payload?: S3PayloadMeta;
}

export interface S3PayloadMeta {
    Id: string;
    Bucket: string;
    Key: string;
    Location: string;
}

export interface SqsExtendedPayloadS3Meta {
    s3BucketName: string;
    s3Key: string;
}

export type SqsExtendedPayloadMeta = [typeof AMAZON_EXTENDED_CLIENT_PAYLOAD_OFFLOADING_REFERENCE, SqsExtendedPayloadS3Meta];
