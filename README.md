![Build PR](https://github.com/aspecto-io/sns-sqs-big-payload/workflows/Build%20PR/badge.svg?branch=master)

# sns-sqs-big-payload

SQS/SNS producer/consumer library. Provides an ability to pass payloads though s3.

## Motivation

[Aspecto](https://www.aspecto.io/?utm_source=github&utm_medium=sqs-sns-big-payload&utm_campaign=readme-p1&utm_content=v1) helps modern development teams solve production issues before they evolve. We collect real production data and perform deep API analysis over it to autogenerate tests and monitor services stability. As a result, we often need to handle large payloads which can't be used with SQS & SNS due to the hard size limit. This library was developed to overcome this challenge - it enables you to manage Amazon SNS & SQS message payloads with Amazon S3 when dealing with payloads larger than 256KB. Key functionality includes:

-   Controlling whether message payloads are always stored in Amazon S3 or only when a message's size exceeds 256KB.
-   Send a message that references a single message object stored in an Amazon S3 bucket.
-   Get the corresponding message object from an Amazon S3 bucket.
-   Handle the interface for large messages between SNS to SQS via S3 bucket in the middle

## Instalation

```
npm install sns-sqs-big-payload
```

Important:

> Make sure you also have `aws-sdk` installed, bacause it's listed as a peer dependency, so won't be installed automatically.

## Usage

The library exports 3 clients:

-   SNS producer
-   SQS producer
-   SQS consumer

All 3 clients are under the same repository since they share a similar contract when sending payloads via S3.

### SNS Producer

```ts
import { SnsProducer } from 'sns-sqs-big-payload';

const snsProducer = SnsProducer.create({
    topicArn: '<topic-arn>',
    region: 'us-east-1',
    // to enable sending large payloads (>256KiB) though S3
    largePayloadThoughS3: true,
    s3Bucket: '...',
});

await snsProducer.sendJSON({
    // ...
});
```

### SQS Producer

```ts
import { SqsProducer } from 'sns-sqs-big-payload';

const sqsProducer = SqsProducer.create({
    queueUrl: '...',
    region: 'us-east-1',
    // to enable sending large payloads (>256KiB) though S3
    largePayloadThoughS3: true,
    s3Bucket: '...',
});

await sqsProducer.sendJSON({
    // ...
});
```

### SQS Consumer

```ts
import { SqsConsumer, SqsConsumerEvents } from 'sns-sqs-big-payload';

const sqsConsumer = SqsConsumer.create({
    queueUrl: '...',
    region: 'us-east-1',
    // to enable loading payloads from S3 automatically
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

// to subscribe for events
sqsConsumer.on(SqsConsumerEvents.messageProcessed, () => {
    // ...
});

sqsConsumer.start();

// to stop processing
sqsConsumer.stop();
```

-   The queue is polled continuously for messages using long polling.
-   Messages are deleted from the queue once the handler function has completed successfully.
-   Throwing an error (or returning a rejected promise) from the handler function will cause the message to be left on the queue. An SQS redrive policy can be used to move messages that cannot be processed to a dead letter queue.
-   By default messages are processed by 10 at a time – a new batch won't be received until the previous one is processed. To adjust number of messages that is being processed in parallel, use the `batchSize` option detailed below.

## Credentials

By default the consumer will look for AWS credentials in the places [specified by the AWS SDK](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/configuring-the-jssdk.html#Setting_AWS_Credentials). The simplest option is to export your credentials as environment variables:

```sh
export AWS_SECRET_ACCESS_KEY=...
export AWS_ACCESS_KEY_ID=...
```

If you need to specify your credentials manually, you can use a pre-configured instance of the [AWS SQS](https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/SQS.html) client:

```ts
import { SqsConsumer } from 'sns-sqs-big-payload';
import * as aws from 'aws-sdk';

aws.config.update({
    region: 'us-east-1',
    accessKeyId: '...',
    secretAccessKey: '...',
});

const consumer = SqsConsumer.create({
    queueUrl: 'https://sqs.us-east-1.amazonaws.com/account-id/queue-name',
    handleMessage: async (message) => {
        // ...
    },
    sqs: new aws.SQS(),
});

consumer.start();
```

## Events and logging

SqsConsumer has an internal [EventEmitter](https://nodejs.org/api/events.html), you can subscribe for events like this:
```ts
sqsConsumer.on(SqsConsumerEvents.messageProcessed, () => {
    // ...
});
```

It sends the following events:

| Event               | Params           | Description                                                                         |
| ------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| started             | None             | Fires when the polling is started                                                   |
| message-received    | `message`        | Fires when a message is received (one per each message, not per batch)              |
| message-processed   | `message`        | Fires after the message is successfully processed and removed from the queue        |
| stopped             | None             | Fires when the polling stops                                                        |
| error               | `{err, message}` | Fires in case of processing error                                                   |
| s3-payload-error    | `{err, message}` | Fires when an error ocurrs during downloading payload from s3                       |
| processing-error    | `{err, message}` | Fires when an error ocurrs during processing (only inside `handleMessage` function) |
| connection-error    | `err`            | Fires when a connection error ocurrs during polling (retriable)                     |
| payload-parse-error | `err`            | Fires when a connection error ocurrs during parsing                                 |

You can also use this enum if you're using TypeScript

```ts
enum SqsConsumerEvents {
    started = 'started',
    messageReceived = 'message-received',
    messageProcessed = 'message-processed',
    stopped = 'stopped',
    error = 'error',
    s3PayloadError = 's3-payload-error',
    processingError = 'processing-error',
    connectionError = 'connection-error',
    payloadParseError = 'payload-parse-error',
}
```

You may subscribe to those events to add logging for example.

## Testing

Since this library heavily relies on AWS APIs, it is less relevant to run an isolated test using mocks. As a result, we recommend testing it using a [localstack](https://github.com/localstack/localstack) or by using real SQS queues and SNS topics.

To run localstack on mac:

```sh
TMPDIR=/private$TMPDIR docker-compose up
```

To run unit tests:

```sh
npm test
```
