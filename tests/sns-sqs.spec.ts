import {
    SqsProducer,
    SqsConsumer,
    SqsProducerOptions,
    SqsConsumerOptions,
    SnsProducerOptions,
    SnsProducer,
} from '../src';

const TEST_QUEUE_URL = 'https://sqs.eu-west-1.amazonaws.com/731241200085/test-consumer-producer';
const TEST_TOPIC_ARN = 'arn:aws:sns:eu-west-1:731241200085:test-sns-producer';

async function sendMessage(msg: any, options: Partial<SqsProducerOptions> = {}) {
    const sqsProducer = SqsProducer.create({
        queueUrl: TEST_QUEUE_URL,
        region: 'eu-west-1',
        ...options,
    });
    await sqsProducer.sendJSON(msg);
}

async function publishMessage(msg: any, options: Partial<SnsProducerOptions> = {}) {
    const snsProducer = SnsProducer.create({
        topicArn: TEST_TOPIC_ARN,
        region: 'eu-west-1',
        ...options,
    });
    await snsProducer.publishJSON(msg);
}

async function receiveMessages(expectedMsgsCount: number, options: Partial<SqsConsumerOptions> = {}): Promise<any> {
    return new Promise((res) => {
        const messages = [];
        const sqsConsumer = SqsConsumer.create({
            queueUrl: TEST_QUEUE_URL,
            region: 'eu-west-1',
            parsePayload: (raw) => JSON.parse(raw),
            handleMessage: async ({ payload }) => {
                messages.push(payload);
                if (messages.length === expectedMsgsCount) {
                    sqsConsumer.stop();
                    res(messages);
                }
            },
            ...options,
        });

        sqsConsumer.start();
    });
}

describe('SQS producer-consumer', () => {
    describe('sending simple messages', () => {
        it('should send and receive the message', async () => {
            const message = { it: 'works' };
            sendMessage(message);
            const [receivedMessage] = await receiveMessages(1);
            expect(receivedMessage).toEqual(message);
        });
    });

    describe('sending message through s3', () => {
        it('should send all message though s3 if configured', async () => {
            const message = { it: 'works' };
            sendMessage(message, { allPayloadThoughS3: true, s3Bucket: 'aspecto-message-payload' });
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
            publishMessage(message);
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
            publishMessage(message, { allPayloadThoughS3: true, s3Bucket: 'aspecto-message-payload' });
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
