import {
    SqsConsumerEvents,
    SqsProducer,
    SqsConsumer,
    SqsProducerOptions,
    SqsConsumerOptions,
    SnsProducerOptions,
    SnsProducer,
} from '../src';

import * as aws from 'aws-sdk';

// Real AWS services (for dev testing)
// const TEST_QUEUE_URL = 'https://sqs.eu-west-1.amazonaws.com/731241200085/test-consumer-producer';
// const TEST_TOPIC_ARN = 'arn:aws:sns:eu-west-1:731241200085:test-sns-producer';
// const TEST_REGION = 'eu-west-1';

// Localstack AWS services
const TEST_QUEUE_URL = 'http://localhost:4576/queue/test-consumer-producer';
const TEST_TOPIC_ARN = 'arn:aws:sns:us-east-1:000000000000:test-sns-producer';
const TEST_REGION = 'us-east-1';
const TEST_ENDPOINTS = {
    sqsEndpointUrl: 'http://localhost:4576',
    snsEndpointUrl: 'http://localhost:4575',
    s3EndpointUrl: 'http://localhost:4572',
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
    await Promise.all([
        await sns.createTopic({ Name: 'test-sns-producer' }).promise(),
        await sqs.createQueue({ QueueName: 'test-consumer-producer' }).promise(),
    ]);
    await sns
        .subscribe({
            Protocol: 'sqs',
            TopicArn: TEST_TOPIC_ARN,
            Endpoint: TEST_QUEUE_URL,
        })
        .promise();
}

async function cleanAws() {
    const { sns, sqs } = getClients();
    await Promise.all([
        sns.deleteTopic({ TopicArn: TEST_TOPIC_ARN }).promise(),
        sqs.deleteQueue({ QueueUrl: TEST_QUEUE_URL }).promise(),
    ]);
}

async function sendMessage(msg: any, options: Partial<SqsProducerOptions> = {}) {
    const { s3 } = getClients();
    const sqsProducer = SqsProducer.create({
        queueUrl: TEST_QUEUE_URL,
        region: TEST_REGION,
        // use localstack endpoints
        ...TEST_ENDPOINTS,
        ...options,
        s3,
    });
    await sqsProducer.sendJSON(msg);
}

async function publishMessage(msg: any, options: Partial<SnsProducerOptions> = {}) {
    const { s3 } = getClients();
    const snsProducer = SnsProducer.create({
        topicArn: TEST_TOPIC_ARN,
        region: TEST_REGION,
        // use localstack endpoints
        ...TEST_ENDPOINTS,
        ...options,
        s3,
    });
    await snsProducer.publishJSON(msg);
}

async function receiveMessages(
    expectedMsgsCount: number,
    options: Partial<SqsConsumerOptions> = {},
    eventHandlers?: Record<string | symbol, (...args) => void>
): Promise<any> {
    const { s3 } = getClients();
    return new Promise((resolve, rej) => {
        const messages = [];
        let timeoutId;

        const sqsConsumer = SqsConsumer.create({
            queueUrl: TEST_QUEUE_URL,
            region: TEST_REGION,
            parsePayload: (raw) => JSON.parse(raw),
            ...options,
            s3,
        });

        sqsConsumer.on(SqsConsumerEvents.messageParsed, ({ payload }) => {
            messages.push(payload);
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
                sendMessage(message);
                const [receivedMessage] = await receiveMessages(1);
                expect(receivedMessage).toEqual(message);
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
                sendMessage(message);
                const [receivedMessage] = await receiveMessages(1, {}, handlers);
                expect(receivedMessage).toEqual(message);

                // success
                expect(handlers[SqsConsumerEvents.started]).toBeCalled();
                expect(handlers[SqsConsumerEvents.messageReceived]).toBeCalled();
                expect(handlers[SqsConsumerEvents.messageParsed]).toBeCalled();
                expect(handlers[SqsConsumerEvents.messageProcessed]).toBeCalled();
                expect(handlers[SqsConsumerEvents.stopped]).toBeCalled();
                // errors
                expect(handlers[SqsConsumerEvents.error]).not.toBeCalled();
                expect(handlers[SqsConsumerEvents.processingError]).not.toBeCalled();
                expect(handlers[SqsConsumerEvents.payloadParseError]).not.toBeCalled();
                expect(handlers[SqsConsumerEvents.s3PayloadError]).not.toBeCalled();
                expect(handlers[SqsConsumerEvents.connectionError]).not.toBeCalled();
            });

            it('should should trigger processingError event', async () => {
                const message = { it: 'works' };
                const handlers = getEventHandlers();
                sendMessage(message);
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
                sendMessage(message, { allPayloadThoughS3: true, s3Bucket: TEST_BUCKET_NAME });
                const [receivedMessage] = await receiveMessages(1, { getPayloadFromS3: true });
                expect(receivedMessage).toEqual(message);
            });
        });

        describe('sending multiple messages', () => {
            it('should receive all the messages that have been sent', async () => {
                sendMessage({ one: 'one' });
                sendMessage({ two: 'two' });
                sendMessage({ three: 'three' });
                const messages = await receiveMessages(3);
                // order is not guaranteed, so just checking if the message is present
                expect(messages).toContainEqual({ one: 'one' });
                expect(messages).toContainEqual({ two: 'two' });
                expect(messages).toContainEqual({ three: 'three' });
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
                expect(receivedMessage).toEqual(message);
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
                expect(receivedMessage).toEqual(message);
            });
        });
    });
});
