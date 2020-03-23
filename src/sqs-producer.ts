import * as aws from 'aws-sdk';
import { v4 as uuid } from 'uuid';
import { PayloadMeta } from './types';

// 256KiB
const MAX_SQS_MESSAGE_SIZE = 256 * 1024;

export interface SqsProducerOptions {
    queueUrl: string;
    region?: string;
    largePayloadThoughS3?: boolean;
    allPayloadThoughS3?: boolean;
    s3Bucket?: string;
    sqs?: aws.SQS;
    s3?: aws.S3;
}

export interface SqsMessageOptions {
    DelaySeconds?: number;
    MessageDeduplicationId?: string;
    MessageGroupId?: string;
}

export class SqsProducer {
    private sqs: aws.SQS;
    private s3: aws.S3;
    private queueUrl: string;
    private largePayloadThoughS3: boolean;
    private allPayloadThoughS3: boolean;
    private s3Bucket: string;

    constructor(options: SqsProducerOptions) {
        if (options.sqs) {
            this.sqs = options.sqs;
        } else {
            this.sqs = new aws.SQS({
                region: options.region,
            });
        }
        if (options.largePayloadThoughS3 || options.allPayloadThoughS3) {
            if (options.s3) {
                this.s3 = options.s3;
            } else {
                this.s3 = new aws.S3({
                    region: options.region,
                });
            }
        }

        this.queueUrl = options.queueUrl;
        this.largePayloadThoughS3 = options.largePayloadThoughS3;
        this.allPayloadThoughS3 = options.allPayloadThoughS3;
        this.s3Bucket = options.s3Bucket;
    }

    static create(options: SqsProducerOptions) {
        return new SqsProducer(options);
    }

    async sendJSON(message: object, options: SqsMessageOptions = {}): Promise<any> {
        const messageBody = JSON.stringify(message);
        const msgSize = Buffer.byteLength(messageBody, 'utf-8');

        if ((msgSize > MAX_SQS_MESSAGE_SIZE && this.largePayloadThoughS3) || this.allPayloadThoughS3) {
            const payloadId = uuid();
            const payloadKey = `${payloadId}.json`;
            const s3Response = await this.s3
                .upload({
                    Bucket: this.s3Bucket,
                    Body: messageBody,
                    Key: payloadKey,
                    ContentType: 'application/json',
                })
                .promise();

            const sqsResponse = await this.sqs
                .sendMessage({
                    QueueUrl: this.queueUrl,
                    MessageBody: JSON.stringify({
                        S3Payload: {
                            Id: payloadId,
                            Bucket: s3Response.Bucket,
                            Key: s3Response.Key,
                            Location: s3Response.Location,
                        },
                    } as PayloadMeta),
                    DelaySeconds: options.DelaySeconds,
                    MessageDeduplicationId: options.MessageDeduplicationId,
                    MessageGroupId: options.MessageGroupId,
                })
                .promise();

            return {
                s3Response,
                sqsResponse,
            };
        } else if (msgSize > MAX_SQS_MESSAGE_SIZE) {
            throw new Error("Message is too big. Use 'largePayloadThoughS3' option to send large payloads though S3.");
        }

        const sqsResponse = await this.sqs
            .sendMessage({
                QueueUrl: this.queueUrl,
                MessageBody: messageBody,
                DelaySeconds: options.DelaySeconds,
                MessageDeduplicationId: options.MessageDeduplicationId,
                MessageGroupId: options.MessageGroupId,
            })
            .promise();

        return {
            sqsResponse,
        };
    }
}
