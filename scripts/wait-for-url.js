#!/usr/bin/env node
const http = require('http');

let timeoutFired = false;

const urlReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
        timeoutFired = true;
        reject(new Error('Timeout'));
    }, 60000);

    getUrl(timeout, resolve, reject);
});

function getUrl(timeoutId, resolve, reject) {
    const url = process.argv[2];
    http.get(url, (resp) => {
        resp.on('data', () => {
            clearTimeout(timeoutId);
            resolve();
        });
    }).on('error', (err) => {
        if (timeoutFired) {
            reject();
            return;
        }
        setTimeout(() => getUrl(timeoutId, resolve, reject), 1000);
    });
}

urlReady.catch((err) => {
    console.log(err);
    process.exit(1);
});
