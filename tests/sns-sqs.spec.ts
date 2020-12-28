import {
    SqsConsumerEvents,
    SqsProducer,
    SqsConsumer,
    SqsProducerOptions,
    SqsConsumerOptions,
    SnsProducerOptions,
    SnsProducer,
    SqsMessage,
} from '../src';

import * as aws from 'aws-sdk';
import { S3PayloadMeta } from '../src/types';

// Real AWS services (for dev testing)
// const TEST_TOPIC_ARN = 'arn:aws:sns:eu-west-1:731241200085:test-sns-producer';
// const TEST_REGION = 'eu-west-1';

// Localstack AWS services
const QUEUE_NAME = 'test-consumer-producer';
const QUEUE_2_NAME = 'test-consumer-producer-2';
let testQueueUrl: string;
let testQueue2Url: string;
const TEST_TOPIC_ARN = 'arn:aws:sns:us-east-1:000000000000:test-sns-producer';
const TEST_REGION = 'us-east-1';
const TEST_ENDPOINTS = {
    sqsEndpointUrl: 'http://localhost:4566',
    snsEndpointUrl: 'http://localhost:4566',
    s3EndpointUrl: 'http://localhost:4566',
};
const TEST_BUCKET_NAME = 'aspecto-message-payload';

function getClients() {
    const sns = new aws.SNS({
        endpoint: TEST_ENDPOINTS.snsEndpointUrl,
        region: TEST_REGION,
    });

    const sqs = new aws.SQS({
        endpoint: TEST_ENDPOINTS.sqsEndpointUrl,
        region: TEST_REGION,
    });

    const s3 = new aws.S3({
        endpoint: TEST_ENDPOINTS.s3EndpointUrl,
        region: TEST_REGION,
        s3ForcePathStyle: true,
    });

    return { sns, sqs, s3 };
}
async function initAws() {
    const { sns, sqs } = getClients();
    const res = await Promise.all([
        await sns.createTopic({ Name: 'test-sns-producer' }).promise(),
        await sqs.createQueue({ QueueName: QUEUE_NAME }).promise(),
        await sqs.createQueue({ QueueName: QUEUE_2_NAME }).promise(),
    ]);
    testQueueUrl = res[1].QueueUrl;
    testQueue2Url= res[2].QueueUrl;
    await sns
        .subscribe({
            Protocol: 'sqs',
            TopicArn: TEST_TOPIC_ARN,
            Endpoint: testQueueUrl,
        })
        .promise();
}

async function cleanAws() {
    const { sns, sqs } = getClients();
    await Promise.all([
        sns.deleteTopic({ TopicArn: TEST_TOPIC_ARN }).promise(),
        sqs.deleteQueue({ QueueUrl: testQueueUrl }).promise(),
        sqs.deleteQueue({ QueueUrl: testQueue2Url }).promise(),
    ]);
}

const getSqsProducer = (options: Partial<SqsProducerOptions> = {}) => {
    const { s3 } = getClients();
    return SqsProducer.create({
        queueUrl: testQueueUrl,
        region: TEST_REGION,
        // use localstack endpoints
        ...TEST_ENDPOINTS,
        ...options,
        s3,
    });
}

async function sendMessage(msg: any, options: Partial<SqsProducerOptions>) {
    const sqsProducer = getSqsProducer(options);
    return await sqsProducer.sendJSON(msg);
}

async function sendS3Payload(s3PayloadMeta: S3PayloadMeta, options: Partial<SqsProducerOptions>) {
    const sqsProducer = getSqsProducer(options);
    return await sqsProducer.sendS3Payload(s3PayloadMeta);
}

const getSnsProducer = (options: Partial<SnsProducerOptions> = {}) => {
    const { s3 } = getClients();
    return SnsProducer.create({
        topicArn: TEST_TOPIC_ARN,
        region: TEST_REGION,
        // use localstack endpoints
        ...TEST_ENDPOINTS,
        ...options,
        s3,
    });
}

async function publishMessage(msg: any, options: Partial<SnsProducerOptions>) {
    const snsProducer = getSnsProducer(options);
    await snsProducer.publishJSON(msg);
}

async function publishS3Payload(s3PayloadMeta: S3PayloadMeta, options: Partial<SnsProducerOptions>) {
    const snsProducer = getSnsProducer(options);
    await snsProducer.publishS3Payload(s3PayloadMeta);
}

async function receiveMessages(
    expectedMsgsCount: number,
    options: Partial<SqsConsumerOptions> = {},
    eventHandlers?: Record<string | symbol, (...args) => void>
): Promise<SqsMessage[]> {
    const { s3 } = getClients();
    return new Promise((resolve, rej) => {
        const messages: SqsMessage[] = [];
        let timeoutId;

        const sqsConsumer = SqsConsumer.create({
            queueUrl: testQueueUrl,
            region: TEST_REGION,
            parsePayload: (raw) => JSON.parse(raw),
            ...options,
            s3,
        });

        sqsConsumer.on(SqsConsumerEvents.messageParsed, (message) => {
            messages.push(message);
        });

        sqsConsumer.on(SqsConsumerEvents.messageProcessed, () => {
            if (messages.length === expectedMsgsCount) {
                sqsConsumer.stop();
                clearTimeout(timeoutId);
                resolve(messages);
            }
        });

        sqsConsumer.on(SqsConsumerEvents.error, () => {
            sqsConsumer.stop();
            clearTimeout(timeoutId);
        });

        sqsConsumer.on(SqsConsumerEvents.processingError, () => {
            sqsConsumer.stop();
            clearTimeout(timeoutId);
            resolve();
        });

        if (eventHandlers) {
            Object.entries(eventHandlers).forEach(([event, handler]) => sqsConsumer.on(event, handler));
        }

        timeoutId = setTimeout(() => {
            rej(new Error("Timeout: SqsConsumer didn't get any messages for 5 seconds."));
            sqsConsumer.stop();
        }, 5000);

        sqsConsumer.start();
    });
}

describe('sns-sqs-big-payload', () => {
    beforeAll(async () => {
        const { s3 } = getClients();
        await s3
            .createBucket({
                Bucket: TEST_BUCKET_NAME,
                ACL: 'public-read',
            })
            .promise();
    });

    beforeEach(async () => {
        await initAws();
    });

    afterEach(async () => {
        await cleanAws();
    });

    describe('SQS producer-consumer', () => {
        describe('sending simple messages', () => {
            it('should send and receive the message', async () => {
                const message = { it: 'works' };
                await sendMessage(message);
                const [receivedMessage] = await receiveMessages(1);
                expect(receivedMessage.payload).toEqual(message);
            });
        });

        describe('events', () => {
            function getEventHandlers() {
                const handlers = Object.keys(SqsConsumerEvents).reduce((acc, key) => {
                    acc[SqsConsumerEvents[key]] = jest.fn();
                    return acc;
                }, {});
                return handlers;
            }

            it('should trigger success events event', async () => {
                const message = { it: 'works' };
                const handlers = getEventHandlers();
                await sendMessage(message);
                const [receivedMessage] = await receiveMessages(1, {}, handlers);
                // trigger macrotask to call event handlers
                await new Promise((res) => setTimeout(res));
                expect(receivedMessage.payload).toEqual(message);

                // success
                expect(handlers[SqsConsumerEvents.started]).toBeCalled();
                expect(handlers[SqsConsumerEvents.messageReceived]).toBeCalled();
                expect(handlers[SqsConsumerEvents.messageParsed]).toBeCalled();
                expect(handlers[SqsConsumerEvents.messageProcessed]).toBeCalled();
                expect(handlers[SqsConsumerEvents.batchProcessed]).toBeCalled();
                expect(handlers[SqsConsumerEvents.pollEnded]).toBeCalled();
                expect(handlers[SqsConsumerEvents.stopped]).toBeCalled();
                // errors
                expect(handlers[SqsConsumerEvents.error]).not.toBeCalled();
                expect(handlers[SqsConsumerEvents.processingError]).not.toBeCalled();
                expect(handlers[SqsConsumerEvents.payloadParseError]).not.toBeCalled();
                expect(handlers[SqsConsumerEvents.s3PayloadError]).not.toBeCalled();
                expect(handlers[SqsConsumerEvents.connectionError]).not.toBeCalled();
            });

            it('should trigger processingError event', async () => {
                const message = { it: 'works' };
                const handlers = getEventHandlers();
                await sendMessage(message);
                await receiveMessages(
                    1,
                    {
                        handleMessage: () => {
                            throw new Error('Processing error');
                        },
                    },
                    handlers
                );

                // errors
                expect(handlers[SqsConsumerEvents.messageReceived]).toBeCalled();
                expect(handlers[SqsConsumerEvents.messageParsed]).toBeCalled();
                expect(handlers[SqsConsumerEvents.processingError]).toBeCalled();
                expect(handlers[SqsConsumerEvents.messageProcessed]).not.toBeCalled();
                expect(handlers[SqsConsumerEvents.error]).not.toBeCalled();
                expect(handlers[SqsConsumerEvents.connectionError]).not.toBeCalled();
                expect(handlers[SqsConsumerEvents.payloadParseError]).not.toBeCalled();
            });
        });

        describe('sending message through s3', () => {
            it('should send all message though s3 if configured', async () => {
                const message = { it: 'works' };
                await sendMessage(message, { allPayloadThoughS3: true, s3Bucket: TEST_BUCKET_NAME });
                const [receivedMessage] = await receiveMessages(1, { getPayloadFromS3: true });
                expect(receivedMessage.payload).toEqual(message);
                expect(receivedMessage.s3PayloadMeta.Bucket).toEqual(TEST_BUCKET_NAME);
                expect(receivedMessage.s3PayloadMeta.Key).toBeDefined();
            });

            it('should send large message through s3', async () => {
                const message = 'x'.repeat(256 * 1024 + 1);
                await sendMessage(message, { largePayloadThoughS3: true, s3Bucket: TEST_BUCKET_NAME });
                const [receivedMessage] = await receiveMessages(1, { getPayloadFromS3: true });
                expect(receivedMessage.payload).toEqual(message);
            });

            it('should send messages larger than messageSizeThreshold through s3', async () => {
                const messageSizeThreshold = 1024;
                const message = 'x'.repeat(messageSizeThreshold + 1);
                const { s3Response } = await sendMessage(message, {
                    largePayloadThoughS3: true,
                    s3Bucket: TEST_BUCKET_NAME,
                    messageSizeThreshold,
                });
                expect(s3Response).toBeDefined();
                const [receivedMessage] = await receiveMessages(1, { getPayloadFromS3: true });
                expect(receivedMessage.payload).toEqual(message);
            });

            it('should send messages smaller than messageSizeThreshold as sqs payload', async () => {
                const messageSizeThreshold = 1024;
                // payload is calculated based on the stringify representation of the message,
                // which includes the '"' chars
                const message = 'x'.repeat(messageSizeThreshold - 3);
                const { s3Response } = await sendMessage(message, {
                    largePayloadThoughS3: true,
                    s3Bucket: TEST_BUCKET_NAME,
                    messageSizeThreshold,
                });
                expect(s3Response).toBeUndefined();
                const [receivedMessage] = await receiveMessages(1, { getPayloadFromS3: true });
                expect(receivedMessage.payload).toEqual(message);
                expect(receivedMessage.s3PayloadMeta).toBeUndefined();
            });

            it('should resend message into other queue with s3 payload', async () => {
                const message = { it: 'works' };
                await sendMessage(message, { allPayloadThoughS3: true, s3Bucket: TEST_BUCKET_NAME });
                const [receivedMessage] = await receiveMessages(1, { getPayloadFromS3: true });
                await sendS3Payload(receivedMessage.s3PayloadMeta, {queueUrl: testQueue2Url});
                const [reReceivedMessage] = await receiveMessages(1, { getPayloadFromS3: true, queueUrl: testQueue2Url });
                expect(reReceivedMessage.payload).toEqual(message);
                expect(reReceivedMessage.s3PayloadMeta).toEqual(receivedMessage.s3PayloadMeta);
            });

        });

        describe('sending multiple messages', () => {
            it('should receive all the messages that have been sent', async () => {
                await Promise.all([
                    sendMessage({ one: 'one' }),
                    sendMessage({ two: 'two' }),
                    sendMessage({ three: 'three' }),
                ]);
                const messages = await receiveMessages(3);
                const messagesPayloads = messages.map(m => m.payload);
                // order is not guaranteed, so just checking if the message is present
                expect(messagesPayloads).toContainEqual({ one: 'one' });
                expect(messagesPayloads).toContainEqual({ two: 'two' });
                expect(messagesPayloads).toContainEqual({ three: 'three' });
            });
        });
    });

    // this set of tests requires SQS queue to be subscribed to the SNS topic that we use
    describe('SNS producer - SQS consumer', () => {
        describe('publishing simple messages', () => {
            it('should publish and receive the message', async () => {
                const message = { it: 'works' };
                await publishMessage(message);
                const [receivedMessage] = await receiveMessages(1, {
                    transformMessageBody: (body) => {
                        const snsMessage = JSON.parse(body);
                        return snsMessage.Message;
                    },
                });
                expect(receivedMessage.payload).toEqual(message);
            });
        });

        describe('publishing message through s3', () => {

            it('should send payload though s3 if configured - for all messages', async () => {
                const message = { it: 'works' };
                await publishMessage(message, { allPayloadThoughS3: true, s3Bucket: TEST_BUCKET_NAME });
                const [receivedMessage] = await receiveMessages(1, {
                    getPayloadFromS3: true,
                    // since it's SNS message we need to unwrap sns envelope first
                    transformMessageBody: (body) => {
                        const snsMessage = JSON.parse(body);
                        return snsMessage.Message;
                    },
                });
                expect(receivedMessage.payload).toEqual(message);
            });

            it('publish to sns with payload already in s3', async () => {
                // publish message to queue 2, read it with s3 metadata, 
                // then send it to sns with s3 payload and read it from queue 1
                const message = { it: 'works' };
                await sendMessage(message, { allPayloadThoughS3: true, s3Bucket: TEST_BUCKET_NAME, queueUrl: testQueue2Url });
                const [receivedMessage] = await receiveMessages(1, { getPayloadFromS3: true, queueUrl: testQueue2Url });

                await publishS3Payload(receivedMessage.s3PayloadMeta);
                const [reReceivedMessage] = await receiveMessages(1, {
                    getPayloadFromS3: true,
                    transformMessageBody: (body) => {
                        const snsMessage = JSON.parse(body);
                        return snsMessage.Message;
                    },
                    queueUrl: testQueueUrl,
                });
                expect(reReceivedMessage.payload).toEqual(message);
                expect(reReceivedMessage.s3PayloadMeta).toEqual(receivedMessage.s3PayloadMeta);
            });
        });
    });
});
