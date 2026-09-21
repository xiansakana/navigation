import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPiclistConfigPatch, publicPiclistConfig } from './piclist-admin.js';

function fixture() {
    var profile = {
        _id: 'b2-assets',
        _configName: 'backblaze',
        accessKeyID: 'old-id',
        secretAccessKey: 'old-secret',
        bucketName: 'old-bucket',
        region: 'old-region',
        endpoint: 'https://old.example.com',
        urlPrefix: 'https://assets.example.com'
    };
    return {
        picBed: { current: 'aws-s3-plist', uploader: 'aws-s3-plist', 'aws-s3-plist': { ...profile } },
        uploader: {
            'aws-s3-plist': { defaultId: 'b2-assets', configList: [{ ...profile }] }
        },
        picgoPlugins: { 'picgo-plugin-datetime-rename': true }
    };
}

test('public config redacts PicList credentials', function() {
    var value = publicPiclistConfig(fixture());
    assert.equal(value.accessKeyConfigured, true);
    assert.equal(value.secretKeyConfigured, true);
    assert.equal('accessKeyID' in value, false);
    assert.equal('secretAccessKey' in value, false);
});

test('blank credentials preserve existing secrets and mirror uploader profile', function() {
    var doc = fixture();
    applyPiclistConfigPatch(doc, {
        bucketName: 'new-bucket',
        region: 'us-east-005',
        endpoint: 'https://s3.us-east-005.backblazeb2.com/',
        urlPrefix: 'https://assets.saoyu.fun/',
        uploadPath: 'images/',
        acl: 'public-read',
        accessKeyID: '',
        secretAccessKey: '',
        pathStyleAccess: true,
        disableBucketPrefixToURL: true,
        renamePluginEnabled: false
    });
    var current = doc.picBed['aws-s3-plist'];
    var mirrored = doc.uploader['aws-s3-plist'].configList[0];
    assert.equal(current.accessKeyID, 'old-id');
    assert.equal(current.secretAccessKey, 'old-secret');
    assert.equal(current.bucketName, 'new-bucket');
    assert.equal(current.endpoint, 'https://s3.us-east-005.backblazeb2.com');
    assert.equal(mirrored.bucketName, 'new-bucket');
    assert.equal(doc.picgoPlugins['picgo-plugin-datetime-rename'], false);
});

test('invalid endpoint is rejected', function() {
    assert.throws(function() {
        applyPiclistConfigPatch(fixture(), {
            bucketName: 'bucket',
            region: 'region',
            endpoint: 'file:///tmp/data',
            urlPrefix: 'https://assets.example.com'
        });
    }, /仅支持 HTTP\/HTTPS/);
});
