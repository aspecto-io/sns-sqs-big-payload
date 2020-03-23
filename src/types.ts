export interface PayloadMeta {
    S3Payload?: S3PayloadMeta;
}

export interface S3PayloadMeta {
    Id: string;
    Bucket: string;
    Key: string;
    Location: string;
}
