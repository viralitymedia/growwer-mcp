import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';

import { BridgeFailure, describeFailure } from '../src/log.ts';

const SECRET = 'gw_sk_PUBLICPREFIX_SecretSentinelNeverPrintedHere';

describe('describeFailure', () => {
  it('names a fetch failure by its class and the code of its cause, not the cause’s message', () => {
    const cause = Object.assign(new Error(`connect ECONNREFUSED ${SECRET}`), { code: 'ECONNREFUSED' });

    assert.equal(describeFailure(new TypeError('fetch failed', { cause })), 'TypeError (ECONNREFUSED)');
  });

  it('keeps the code of a dual-stack failure, whose cause has an empty message', () => {
    const cause = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });

    assert.equal(describeFailure(new TypeError('fetch failed', { cause })), 'TypeError (ECONNREFUSED)');
  });

  it('prints nothing of the header value undici refuses, which is the credential', () => {
    let refusal: unknown;

    try {
      new Headers({ Authorization: `Bearer ${SECRET}\nCanaryOnTheSecondLine` });
    } catch (error) {
      refusal = error;
    }

    assert.ok(refusal instanceof TypeError, 'undici no longer refuses the header, so this proved nothing');
    assert.match(refusal.message, /SecretSentinel/, 'undici no longer quotes the value, so this proved nothing');
    assert.equal(describeFailure(refusal), 'TypeError');
  });

  it('never prints the message of an error with no code', () => {
    assert.equal(describeFailure(new Error(`upstream said ${SECRET}`)), 'Error');
  });

  it('names an SDK error by its own code, not by its message', () => {
    const error = new SdkError(SdkErrorCode.ClientHttpUnexpectedContent, `Unexpected content type: ${SECRET}`);

    assert.equal(describeFailure(error), 'SdkError (CLIENT_HTTP_UNEXPECTED_CONTENT)');
  });

  it('drops a name or a code that is not a plain identifier', () => {
    const error = Object.assign(new Error('x'), { name: `Bearer ${SECRET}`, code: `${SECRET} here` });

    assert.equal(describeFailure(error), 'Error');
  });

  it('prints nothing of a thrown value that is not an Error', () => {
    assert.equal(describeFailure(SECRET), 'a failure that is not an Error');
  });

  it('shows the bridge’s own wording, which is fixed text', () => {
    assert.equal(
      describeFailure(new BridgeFailure('the upstream refused the replayed handshake')),
      'the upstream refused the replayed handshake'
    );
  });

  it('names an HTTP failure by its status, not its body', () => {
    const error = new SdkHttpError(SdkErrorCode.ClientHttpNotImplemented, `Error POSTing to endpoint: ${SECRET}`, {
      status: 503,
      statusText: 'Service Unavailable',
      text: SECRET,
    });

    assert.equal(describeFailure(error), 'HTTP 503 Service Unavailable');
  });
});
