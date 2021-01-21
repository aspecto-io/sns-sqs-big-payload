import { MessageAttributeMap } from 'aws-sdk/clients/sns';
import { S3PayloadMeta, PayloadMeta, SqsExtendedPayloadMeta } from './types';

export const SQS_LARGE_PAYLOAD_SIZE_ATTRIBUTE = 'SQSLargePayloadSize';

export function createExtendedCompatibilityAttributeMap(msgSize: number): MessageAttributeMap {
    const result = {};
    result[SQS_LARGE_PAYLOAD_SIZE_ATTRIBUTE] = {
        StringValue: '' + msgSize,
        DataType: 'Number',
    };
    return result;
}

export function buildS3Payload(s3PayloadMeta: S3PayloadMeta): string {
    return JSON.stringify({
        S3Payload: s3PayloadMeta,
    } as PayloadMeta);
}

export function buildS3PayloadWithExtendedCompatibility(s3PayloadMeta: S3PayloadMeta): string {
    return JSON.stringify({
        s3BucketName: s3PayloadMeta.Bucket,
        s3Key: s3PayloadMeta.Key,
    } as SqsExtendedPayloadMeta);
}
