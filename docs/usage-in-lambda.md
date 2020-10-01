
## Usage in Lambda

SQSConsumer can also be used to process messages directly, w/o polling part. This is convenient to use in a lambda function which is already subscribed to sqs queue.
For example:

```ts
import { SqsConsumer, SqsConsumerEvents } from 'sns-sqs-big-payload';

const sqsConsumer = SqsConsumer.create({
    // no need to specify the queue url for the lambda use case
    // the rest of the options are pretty much the same
    region: 'us-east-1',
    getPayloadFromS3: true,
    s3Bucket: '...',
    // if the queue is subscribed to SNS
    // the message will arrive wrapped in sns envelope
    // so we need to unwrap it first
    transformMessageBody: (body) => {
        const snsMessage = JSON.parse(body);
        return snsMessage.Message;
    },
    // if you expect json payload - use `parsePayload` hook to parse it
    parsePayload: (raw) => JSON.parse(raw),
    // message handler, payload already parsed at this point
    handleMessage: async ({ payload }) => {
        // ...
    },
});

// Lambda main function
// Typical event may look like this:
// {
//     "Records": [
//         {
//             "messageId": "059f36b4-87a3-44ab-83d2-661975830a7d",
//             "receiptHandle": "AQEBwJnKyrHigUMZj6rYigCgxlaS3SLy0a...",
//             "body": "test",
//             "attributes": {
//                 "ApproximateReceiveCount": "1",
//                 "SentTimestamp": "1545082649183",
//                 "SenderId": "AIDAIENQZJOLO23YVJ4VO",
//                 "ApproximateFirstReceiveTimestamp": "1545082649185"
//             },
//             "messageAttributes": {},
//             "md5OfBody": "098f6bcd4621d373cade4e832627b4f6",
//             "eventSource": "aws:sqs",
//             "eventSourceARN": "arn:aws:sqs:us-east-2:123456789012:my-queue",
//             "awsRegion": "us-east-2"
//         }
//     ]
// }
exports.handler = async function (event, context) {
    // you may want to wrap each processing call with try-catch.
    // if lambda handler raises an error, the whole batch of messages will be re-processed.
    await Promise.all(
        event.Records.map(async (record) => {
            // lambda runtime will delete the message automatically, so we set `deleteAfterProcessing` to `false`
            await sqsConsumer.processMessage(record, { deleteAfterProcessing: false });
        })
    );
    return {};
};
```
