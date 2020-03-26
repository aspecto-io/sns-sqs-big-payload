import * as aws from 'aws-sdk';
import { EventEmitter } from 'events';
import { Message, ReceiveMessageRequest, ReceiveMessageResult } from 'aws-sdk/clients/sqs';
import { AWSError } from 'aws-sdk';
import { PayloadMeta, S3PayloadMeta } from './types';

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
    parsePayload?(payload: any): any;
    transformMessageBody?(messageBody: any): any;
}

export enum SqsConsumerEvents {
    started = 'started',
    messageReceived = 'message-received',
    messageParsed = 'message-parsed',
    messageProcessed = 'message-processed',
    stopped = 'stopped',
    error = 'error',
    s3PayloadError = 's3-payload-error',
    processingError = 'processing-error',
    connectionError = 'connection-error',
    payloadParseError = 'payload-parse-error',
}

interface SqsMessage {
    payload: any;
    message: Message;
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
    private pollingInterval = 1000;
    private connErrorTimeout = 10000;
    private handleMessage?: (message: SqsMessage) => Promise<void>;
    private parsePayload?: (payload: any) => any;
    private transformMessageBody?: (messageBody: any) => any;

    constructor(options: SqsConsumerOptions) {
        if (options.sqs) {
            this.sqs = options.sqs;
        } else {
            this.sqs = new aws.SQS({
                region: options.region,
                endpoint: options.sqsEndpointUrl,
            });
        }
        if (options.getPayloadFromS3 || options.getPayloadFromS3) {
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
        this.parsePayload = options.parsePayload;
        this.transformMessageBody = options.transformMessageBody;
    }

    static create(options: SqsConsumerOptions) {
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

    private poll(): void {
        if (!this.started) return;
        let currentPollingInterval = this.pollingInterval;

        this.receiveMessages({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: this.batchSize,
            WaitTimeSeconds: this.waitTimeSeconds,
        })
            .then((response) => {
                if (!this.started) return;
                return this.handleSqsResponse(response);
            })
            .catch((err) => {
                if (this.isConnError(err)) {
                    this.events.emit(SqsConsumerEvents.connectionError, err);
                    currentPollingInterval = this.connErrorTimeout;
                } else {
                    this.events.emit(SqsConsumerEvents.error, err);
                }
            })
            .then(() => {
                setTimeout(this.poll.bind(this), currentPollingInterval);
            })
            .catch((err) => {
                this.events.emit('error', err);
            });
    }

    private isConnError(err: AWSError): Boolean {
        return err.statusCode === 403 || err.code === 'CredentialsError' || err.code === 'UnknownEndpoint';
    }

    private async handleSqsResponse(result: ReceiveMessageResult): Promise<void> {
        if (result && result.Messages) {
            await Promise.all(result.Messages.map((message) => this.processMessage(message)));
        }
    }

    private async processMessage(message: Message): Promise<void> {
        try {
            this.events.emit(SqsConsumerEvents.messageReceived, message);
            const messageBody = this.transformMessageBody ? this.transformMessageBody(message.Body) : message.Body;
            const rawPayload = await this.getMessagePayload(messageBody);
            const payload = this.parseMessagePayload(rawPayload);
            this.events.emit(SqsConsumerEvents.messageParsed, { message, payload });
            if (this.handleMessage) {
                await this.handleMessage({ payload, message });
            }
            await this.deleteMessage(message);
            this.events.emit(SqsConsumerEvents.messageProcessed, message);
        } catch (err) {
            this.events.emit(SqsConsumerEvents.processingError, { err, message });
        }
    }

    private async getMessagePayload(messageBody: any): Promise<any> {
        if (!this.getPayloadFromS3) {
            return messageBody;
        }

        const msgJson: PayloadMeta = JSON.parse(messageBody);
        const s3PayloadMeta: S3PayloadMeta = msgJson?.S3Payload;
        if (s3PayloadMeta) {
            try {
                const s3Response = await this.s3
                    .getObject({ Bucket: s3PayloadMeta.Bucket, Key: s3PayloadMeta.Key })
                    .promise();
                return s3Response.Body;
            } catch (err) {
                this.events.emit(SqsConsumerEvents.s3PayloadError, { err, message: msgJson });
                throw err;
            }
        }

        return messageBody;
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
}
