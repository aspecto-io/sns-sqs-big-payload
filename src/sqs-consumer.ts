import * as aws from 'aws-sdk';
import { EventEmitter } from 'events';
import { Message, MessageBodyAttributeMap, ReceiveMessageRequest, ReceiveMessageResult } from 'aws-sdk/clients/sqs';
import { AWSError } from 'aws-sdk';
import { PayloadMeta, S3PayloadMeta, SqsExtendedPayloadMeta } from './types';
import { SQS_LARGE_PAYLOAD_SIZE_ATTRIBUTE } from './constants';

export interface SqsConsumerOptions {
    queueUrl: string;
    region?: string;
    batchSize?: number;
    waitTimeSeconds?: number;
    getPayloadFromS3?: boolean;
    sqs?: aws.SQS;
    s3?: aws.S3;
    sqsEndpointUrl?: string;
    s3EndpointUrl?: string;
    handleMessage?(message: SqsMessage): Promise<void>;
    handleBatch?(messages: SqsMessage[]): Promise<Message[]|void>;
    parsePayload?(payload: any): any;
    transformMessageBody?(messageBody: any): any;
    // Opt-in to enable compatibility with
    // Amazon SQS Extended Client Java Library (and other compatible libraries)
    extendedLibraryCompatibility?: boolean;
}

export interface ProcessingOptions {
    deleteAfterProcessing?: boolean;
}

export enum SqsConsumerEvents {
    started = 'started',
    messageReceived = 'message-received',
    messageParsed = 'message-parsed',
    messageProcessed = 'message-processed',
    batchProcessed = 'batch-processed',
    stopped = 'stopped',
    pollEnded = 'poll-ended',
    error = 'error',
    s3PayloadError = 's3-payload-error',
    s3extendedPayloadError = 's3-extended-payload-error',
    processingError = 'processing-error',
    connectionError = 'connection-error',
    payloadParseError = 'payload-parse-error',
}

export interface SqsMessage {
    payload: any;
    message: Message;
    s3PayloadMeta: S3PayloadMeta;
}

export class SqsConsumer {
    private sqs: aws.SQS;
    private s3: aws.S3;
    private queueUrl: string;
    private getPayloadFromS3: boolean;
    private batchSize: number;
    private waitTimeSeconds: number;
    private started = false;
    private events = new EventEmitter();
    private connErrorTimeout = 10000;
    private handleMessage?: (message: SqsMessage) => Promise<void>;
    private handleBatch?: (messagesWithPayload: SqsMessage[]) => Promise<Message[]|void>;
    private parsePayload?: (payload: any) => any;
    private transformMessageBody?: (messageBody: any) => any;
    private extendedLibraryCompatibility: boolean;

    constructor(options: SqsConsumerOptions) {
        if (options.sqs) {
            this.sqs = options.sqs;
        } else {
            this.sqs = new aws.SQS({
                region: options.region,
                endpoint: options.sqsEndpointUrl,
            });
        }
        if (options.getPayloadFromS3) {
            if (options.s3) {
                this.s3 = options.s3;
            } else {
                this.s3 = new aws.S3({
                    region: options.region,
                    endpoint: options.s3EndpointUrl,
                });
            }
        }

        this.queueUrl = options.queueUrl;
        this.getPayloadFromS3 = options.getPayloadFromS3;
        this.batchSize = options.batchSize || 10;
        this.waitTimeSeconds = options.waitTimeSeconds || 20;
        this.handleMessage = options.handleMessage;
        this.handleBatch = options.handleBatch;
        this.parsePayload = options.parsePayload;
        this.transformMessageBody = options.transformMessageBody;
        this.extendedLibraryCompatibility = options.extendedLibraryCompatibility;
    }

    static create(options: SqsConsumerOptions): SqsConsumer {
        return new SqsConsumer(options);
    }

    start(): void {
        if (this.started) return;
        this.started = true;
        this.poll();
        this.events.emit(SqsConsumerEvents.started);
    }

    stop(): void {
        this.started = false;
        this.events.emit(SqsConsumerEvents.stopped);
    }

    on(event: string | symbol, handler: (...args: any) => void): void {
        this.events.on(event, handler);
    }

    async processMessage(message: Message, options: ProcessingOptions): Promise<void> {
        await this.processMsg(message, options);
    }

    private async poll() {
        while (this.started) {
            try {
                const response = await this.receiveMessages({
                    QueueUrl: this.queueUrl,
                    MaxNumberOfMessages: this.batchSize,
                    WaitTimeSeconds: this.waitTimeSeconds,
                    MessageAttributeNames: [SQS_LARGE_PAYLOAD_SIZE_ATTRIBUTE],
                });
                if (!this.started) return;
                await this.handleSqsResponse(response);
            } catch (err) {
                if (this.isConnError(err)) {
                    this.events.emit(SqsConsumerEvents.connectionError, err);
                    await new Promise((resolve) => setTimeout(resolve, this.connErrorTimeout));
                } else {
                    this.events.emit(SqsConsumerEvents.error, err);
                }
            }
            this.events.emit(SqsConsumerEvents.batchProcessed);
        }
        this.events.emit(SqsConsumerEvents.pollEnded);
    }

    private isConnError(err: AWSError): boolean {
        return err.statusCode === 403 || err.code === 'CredentialsError' || err.code === 'UnknownEndpoint';
    }

    private async handleSqsResponse(result: ReceiveMessageResult): Promise<void> {
        if (result && result.Messages) {
            if (this.handleBatch) {
                await this.processBatch(result.Messages);
            } else {
                await Promise.all(result.Messages.map((message) => this.processMsg(message)));
            }
        }
    }

    private async processBatch(messages: Message[]) {
        try {
            const messagesWithPayload = await Promise.all(messages.map(async message => {
                const { payload, s3PayloadMeta } = await this.preparePayload(message);
                const messageWithPayload = {
                    message,
                    payload,
                    s3PayloadMeta,
                };

                return messageWithPayload;
            }));

            const messagesToDelete = await this.handleBatch(messagesWithPayload);
            if (messagesToDelete && messagesToDelete?.length)
                await this.deleteBatch(messagesToDelete);
            else if (messagesToDelete === undefined)
                await this.deleteBatch(messages);

        } catch (err) {
            this.events.emit(SqsConsumerEvents.processingError, { err, messages });
        }
    }

    private async preparePayload(message: Message) {
        const messageBody = this.transformMessageBody ? this.transformMessageBody(message.Body) : message.Body;
        const { rawPayload, s3PayloadMeta } = await this.getMessagePayload(messageBody, message.MessageAttributes);
        const payload = this.parseMessagePayload(rawPayload);

        return {
            payload,
            s3PayloadMeta,
        }
    }

    private async processMsg(
        message: Message,
        { deleteAfterProcessing = true }: ProcessingOptions = {}
    ): Promise<void> {
        try {
            this.events.emit(SqsConsumerEvents.messageReceived, message);
            const { payload, s3PayloadMeta } = await this.preparePayload(message);
            this.events.emit(SqsConsumerEvents.messageParsed, {
                message,
                payload,
                s3PayloadMeta,
            });
            if (this.handleMessage) {
                await this.handleMessage({ payload, message, s3PayloadMeta });
            }
            if (deleteAfterProcessing) {
                await this.deleteMessage(message);
            }
            this.events.emit(SqsConsumerEvents.messageProcessed, message);
        } catch (err) {
            this.events.emit(SqsConsumerEvents.processingError, { err, message });
        }
    }

    private async getMessagePayload(
        messageBody: any,
        attributes: MessageBodyAttributeMap
    ): Promise<{ rawPayload: any; s3PayloadMeta?: S3PayloadMeta }> {
        if (!this.getPayloadFromS3) {
            return { rawPayload: messageBody };
        }
        let s3PayloadMeta: S3PayloadMeta;
        const s3Object: SqsExtendedPayloadMeta | PayloadMeta = JSON.parse(messageBody);
        if (this.extendedLibraryCompatibility && attributes && attributes[SQS_LARGE_PAYLOAD_SIZE_ATTRIBUTE]) {
            const msgJson = s3Object as SqsExtendedPayloadMeta;
            if (!Array.isArray(msgJson) || msgJson.length !== 2) {
                const err = new Error('Invalid message format, expected an array with 2 elements');
                this.events.emit(SqsConsumerEvents.s3extendedPayloadError, {
                    err,
                    message: s3Object,
                });
                throw err;
            }

            const s3Key = msgJson[1]?.s3Key;
            const s3BucketName = msgJson[1]?.s3BucketName;

            if (!s3Key?.length || !s3BucketName?.length) {
                const err = new Error('Invalid message format, s3Key and s3BucketName fields are required');
                this.events.emit(SqsConsumerEvents.s3extendedPayloadError, {
                    err,
                    message: s3Object,
                });
                throw err;
            }

            s3PayloadMeta = {
                Bucket: s3BucketName,
                Key: s3Key,
                Id: 'not available in extended compatibility mode',
                Location: 'not available in extended compatibility mode',
            };
        } else {
            const msgJson = s3Object as PayloadMeta;
            s3PayloadMeta = msgJson?.S3Payload;
        }
        if (s3PayloadMeta) {
            try {
                const s3Response = await this.s3
                    .getObject({ Bucket: s3PayloadMeta.Bucket, Key: s3PayloadMeta.Key })
                    .promise();
                return { rawPayload: s3Response.Body, s3PayloadMeta };
            } catch (err) {
                this.events.emit(SqsConsumerEvents.s3PayloadError, {
                    err,
                    message: s3Object,
                });
                throw err;
            }
        }

        return { rawPayload: messageBody };
    }

    private parseMessagePayload(rawPayload: any) {
        if (this.parsePayload) {
            try {
                const payload = this.parsePayload(rawPayload);
                return payload;
            } catch (err) {
                this.events.emit(SqsConsumerEvents.payloadParseError, err);
                throw err;
            }
        }

        return rawPayload;
    }

    private async receiveMessages(params: ReceiveMessageRequest): Promise<ReceiveMessageResult> {
        return await this.sqs.receiveMessage(params).promise();
    }

    private async deleteMessage(message: Message): Promise<void> {
        await this.sqs
            .deleteMessage({
                QueueUrl: this.queueUrl,
                ReceiptHandle: message.ReceiptHandle,
            })
            .promise();
    }

    private async deleteBatch(messages: Message[]): Promise<void> {
        await this.sqs
            .deleteMessageBatch({
                QueueUrl: this.queueUrl,
                Entries: messages.map((message, index) => ({
                    Id: index.toString(),
                    ReceiptHandle: message.ReceiptHandle,
                })),
            })
            .promise();
    }
}
