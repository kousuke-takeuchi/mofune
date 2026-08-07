import { describe, it, expect } from 'vitest'
import { S3ListParseError, parseListObjectsV2 } from '../../../src/storage/s3/list'

const page = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>mofune</Name>
  <Prefix>midori/events/</Prefix>
  <KeyCount>2</KeyCount>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcxLPRx1Tr</NextContinuationToken>
  <Contents>
    <Key>midori/events/20260807T091234-a1b2.enc</Key>
    <LastModified>2026-08-07T09:12:34.000Z</LastModified>
    <Size>512</Size>
  </Contents>
  <Contents>
    <Key>midori/events/20260807T091300-c3d4.enc</Key>
    <LastModified>2026-08-07T09:13:00.000Z</LastModified>
    <Size>1024</Size>
  </Contents>
</ListBucketResult>`

const lastPage = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>mofune</Name>
  <KeyCount>0</KeyCount>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`

describe('parseListObjectsV2', () => {
  it('extracts every key in document order', () => {
    expect(parseListObjectsV2(page).entries.map((entry) => entry.path)).toEqual([
      'midori/events/20260807T091234-a1b2.enc',
      'midori/events/20260807T091300-c3d4.enc',
    ])
  })

  it('extracts the size of each object', () => {
    expect(parseListObjectsV2(page).entries.map((entry) => entry.size)).toEqual([512, 1024])
  })

  it('returns the continuation token when the result is truncated', () => {
    expect(parseListObjectsV2(page).nextToken).toBe('1ueGcxLPRx1Tr')
  })

  it('returns a null token when the result is not truncated', () => {
    expect(parseListObjectsV2(lastPage).nextToken).toBeNull()
  })

  it('returns no entries for an empty bucket listing', () => {
    expect(parseListObjectsV2(lastPage).entries).toEqual([])
  })

  it('decodes XML entities in keys', () => {
    const xml = `<ListBucketResult><IsTruncated>false</IsTruncated><Contents>
      <Key>midori/a&amp;b.enc</Key><Size>1</Size></Contents></ListBucketResult>`
    expect(parseListObjectsV2(xml).entries[0]?.path).toBe('midori/a&b.enc')
  })

  it('rejects a response that is not a bucket listing', () => {
    expect(() => parseListObjectsV2('<Error><Code>AccessDenied</Code></Error>')).toThrow(
      S3ListParseError,
    )
  })
})
