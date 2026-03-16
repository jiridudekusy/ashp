import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RulesDAO, RequestLogDAO, ApprovalQueueDAO } from './interfaces.js';

describe('RulesDAO', () => {
  const dao = new RulesDAO();
  for (const method of ['list', 'get', 'create', 'update', 'delete', 'match']) {
    it(`${method} rejects with not implemented`, async () => {
      await assert.rejects(() => dao[method](), /not implemented/i);
    });
  }
});

describe('RequestLogDAO', () => {
  const dao = new RequestLogDAO();
  for (const method of ['insert', 'query', 'getById', 'cleanup']) {
    it(`${method} rejects with not implemented`, async () => {
      await assert.rejects(() => dao[method](), /not implemented/i);
    });
  }
});

describe('ApprovalQueueDAO', () => {
  const dao = new ApprovalQueueDAO();
  for (const method of ['enqueue', 'resolve', 'listPending']) {
    it(`${method} rejects with not implemented`, async () => {
      await assert.rejects(() => dao[method](), /not implemented/i);
    });
  }
});
