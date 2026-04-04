import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from '../../../src/dao/sqlite/connection.js';
import { SqlitePoliciesDAO } from '../../../src/dao/sqlite/policies.js';
import { SqliteRulesDAO } from '../../../src/dao/sqlite/rules.js';
import { SqliteAgentsDAO } from '../../../src/dao/sqlite/agents.js';

describe('SqlitePoliciesDAO', () => {
  let dir, db, dao, rulesDAO, agentsDAO;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ashp-policies-test-'));
    db = createConnection(join(dir, 'test.db'), 'test-key');
    dao = new SqlitePoliciesDAO(db);
    rulesDAO = new SqliteRulesDAO(db);
    agentsDAO = new SqliteAgentsDAO(db);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('create + get round-trip', async () => {
    const policy = await dao.create({ name: 'test-policy', description: 'A test policy' });
    assert.ok(policy.id);
    assert.equal(policy.name, 'test-policy');
    assert.equal(policy.description, 'A test policy');
    assert.ok(policy.created_at);

    const fetched = await dao.get(policy.id);
    assert.deepEqual(fetched, policy);
  });

  it('list returns all policies including default from migration', async () => {
    const list = await dao.list();
    // Migration v2->v3 creates a "default" policy
    assert.ok(list.length >= 1);
    assert.ok(list.some(p => p.name === 'default'));
  });

  it('list returns newly created policies', async () => {
    await dao.create({ name: 'policy-a', description: '' });
    await dao.create({ name: 'policy-b', description: 'B' });
    const list = await dao.list();
    const names = list.map(p => p.name);
    assert.ok(names.includes('policy-a'));
    assert.ok(names.includes('policy-b'));
  });

  it('update modifies name and description', async () => {
    const policy = await dao.create({ name: 'original', description: 'old desc' });
    const updated = await dao.update(policy.id, { name: 'renamed', description: 'new desc' });
    assert.equal(updated.name, 'renamed');
    assert.equal(updated.description, 'new desc');
    assert.equal(updated.id, policy.id);
  });

  it('update returns null for missing policy', async () => {
    const result = await dao.update(99999, { name: 'ghost' });
    assert.equal(result, null);
  });

  it('delete removes policy', async () => {
    const policy = await dao.create({ name: 'doomed', description: '' });
    await dao.delete(policy.id);
    const result = await dao.get(policy.id);
    assert.equal(result, null);
  });

  it('delete sets rules policy_id to NULL (FK ON DELETE SET NULL)', async () => {
    const policy = await dao.create({ name: 'parent-policy', description: '' });
    const rule = await rulesDAO.create({
      name: 'scoped-rule',
      url_pattern: '.*',
      action: 'allow',
      priority: 1,
      policy_id: policy.id,
    });
    assert.equal(rule.policy_id, policy.id);

    await dao.delete(policy.id);
    const updatedRule = await rulesDAO.get(rule.id);
    assert.equal(updatedRule.policy_id, null);
  });

  describe('addChild + getTree', () => {
    it('addChild and getTree shows parent-child relationship', async () => {
      const parent = await dao.create({ name: 'parent', description: '' });
      const child = await dao.create({ name: 'child', description: '' });
      await dao.addChild(parent.id, child.id);

      const tree = await dao.getTree();
      const parentNode = tree.find(p => p.id === parent.id);
      assert.ok(parentNode, 'parent should be in tree roots');
      assert.ok(Array.isArray(parentNode.children));
      assert.equal(parentNode.children.length, 1);
      assert.equal(parentNode.children[0].id, child.id);

      // child should NOT be a root
      assert.ok(!tree.find(p => p.id === child.id), 'child should not appear as a root');
    });

    it('removeChild detaches sub-policy', async () => {
      const parent = await dao.create({ name: 'p', description: '' });
      const child = await dao.create({ name: 'c', description: '' });
      await dao.addChild(parent.id, child.id);
      await dao.removeChild(parent.id, child.id);

      const tree = await dao.getTree();
      const parentNode = tree.find(n => n.id === parent.id);
      assert.equal(parentNode.children.length, 0);
      // child should now appear as a root
      assert.ok(tree.find(n => n.id === child.id), 'child should be a root after removal');
    });

    it('default policy (from migration) appears in tree', async () => {
      const tree = await dao.getTree();
      assert.ok(tree.some(p => p.name === 'default'));
    });
  });

  describe('cycle detection', () => {
    it('rejects self-reference', async () => {
      const p = await dao.create({ name: 'self', description: '' });
      await assert.rejects(() => dao.addChild(p.id, p.id), /cycle|self/i);
    });

    it('rejects cycle A -> B -> A', async () => {
      const a = await dao.create({ name: 'a', description: '' });
      const b = await dao.create({ name: 'b', description: '' });
      await dao.addChild(a.id, b.id);
      await assert.rejects(() => dao.addChild(b.id, a.id), /cycle/i);
    });

    it('rejects deep cycle A -> B -> C -> A', async () => {
      const a = await dao.create({ name: 'da', description: '' });
      const b = await dao.create({ name: 'db', description: '' });
      const c = await dao.create({ name: 'dc', description: '' });
      await dao.addChild(a.id, b.id);
      await dao.addChild(b.id, c.id);
      await assert.rejects(() => dao.addChild(c.id, a.id), /cycle/i);
    });
  });

  describe('agent assignment', () => {
    it('assignToAgent + getAgentPolicies', async () => {
      const agent = await agentsDAO.create({ name: 'bot1', description: '' });
      const policy = await dao.create({ name: 'agent-policy', description: '' });
      await dao.assignToAgent(policy.id, agent.id);

      const policies = await dao.getAgentPolicies(agent.id);
      assert.ok(policies.some(p => p.id === policy.id));
    });

    it('unassignFromAgent removes assignment', async () => {
      const agent = await agentsDAO.create({ name: 'bot2', description: '' });
      const policy = await dao.create({ name: 'p2', description: '' });
      await dao.assignToAgent(policy.id, agent.id);
      await dao.unassignFromAgent(policy.id, agent.id);

      const policies = await dao.getAgentPolicies(agent.id);
      assert.ok(!policies.some(p => p.id === policy.id));
    });

    it('getAgentPolicies returns empty for agent with no assignments', async () => {
      const agent = await agentsDAO.create({ name: 'bot3', description: '' });
      const policies = await dao.getAgentPolicies(agent.id);
      assert.deepEqual(policies, []);
    });
  });

  describe('resolveAgentRules', () => {
    it('returns flat merged rules from assigned policies, priority sorted', async () => {
      const agent = await agentsDAO.create({ name: 'resolver-bot', description: '' });
      const policy = await dao.create({ name: 'res-policy', description: '' });
      await dao.assignToAgent(policy.id, agent.id);

      await rulesDAO.create({ name: 'low', url_pattern: '.*', action: 'allow', priority: 1, policy_id: policy.id });
      await rulesDAO.create({ name: 'high', url_pattern: '.*', action: 'deny', priority: 100, policy_id: policy.id });
      await rulesDAO.create({ name: 'disabled', url_pattern: '.*', action: 'allow', priority: 50, policy_id: policy.id, enabled: false });

      const rules = await dao.resolveAgentRules(agent.id);
      // Only enabled rules
      assert.equal(rules.length, 2);
      assert.equal(rules[0].name, 'high');
      assert.equal(rules[1].name, 'low');
    });

    it('includes rules from sub-policies', async () => {
      const agent = await agentsDAO.create({ name: 'sub-bot', description: '' });
      const parent = await dao.create({ name: 'sub-parent', description: '' });
      const child = await dao.create({ name: 'sub-child', description: '' });
      await dao.addChild(parent.id, child.id);
      await dao.assignToAgent(parent.id, agent.id);

      await rulesDAO.create({ name: 'parent-rule', url_pattern: '.*', action: 'allow', priority: 10, policy_id: parent.id });
      await rulesDAO.create({ name: 'child-rule', url_pattern: '.*', action: 'deny', priority: 20, policy_id: child.id });

      const rules = await dao.resolveAgentRules(agent.id);
      const names = rules.map(r => r.name);
      assert.ok(names.includes('parent-rule'), 'should include parent rule');
      assert.ok(names.includes('child-rule'), 'should include child rule');
      // priority order: child-rule (20) before parent-rule (10)
      assert.equal(rules[0].name, 'child-rule');
      assert.equal(rules[1].name, 'parent-rule');
    });

    it('returns empty array for agent without policies', async () => {
      const agent = await agentsDAO.create({ name: 'empty-bot', description: '' });
      const rules = await dao.resolveAgentRules(agent.id);
      assert.deepEqual(rules, []);
    });

    it('multi-policy: allow wins over deny at same priority', async () => {
      const agent = await agentsDAO.create({ name: 'multi-bot', description: '' });
      const policyA = await dao.create({ name: 'allow-policy', description: '' });
      const policyB = await dao.create({ name: 'deny-policy', description: '' });
      await dao.assignToAgent(policyA.id, agent.id);
      await dao.assignToAgent(policyB.id, agent.id);

      await rulesDAO.create({ name: 'allow-example', url_pattern: '.*example\\.com.*', action: 'allow', priority: 10, policy_id: policyA.id });
      await rulesDAO.create({ name: 'deny-example', url_pattern: '.*example\\.com.*', action: 'deny', priority: 10, policy_id: policyB.id });

      const rules = await dao.resolveAgentRules(agent.id);
      assert.equal(rules.length, 2);
      // Allow should come first when priority is equal
      assert.equal(rules[0].action, 'allow');
      assert.equal(rules[1].action, 'deny');
    });

    it('multi-policy: higher priority deny still wins over lower priority allow', async () => {
      const agent = await agentsDAO.create({ name: 'priority-bot', description: '' });
      const policyA = await dao.create({ name: 'low-allow', description: '' });
      const policyB = await dao.create({ name: 'high-deny', description: '' });
      await dao.assignToAgent(policyA.id, agent.id);
      await dao.assignToAgent(policyB.id, agent.id);

      await rulesDAO.create({ name: 'allow-low', url_pattern: '.*example\\.com.*', action: 'allow', priority: 5, policy_id: policyA.id });
      await rulesDAO.create({ name: 'deny-high', url_pattern: '.*example\\.com.*', action: 'deny', priority: 20, policy_id: policyB.id });

      const rules = await dao.resolveAgentRules(agent.id);
      assert.equal(rules[0].name, 'deny-high');
      assert.equal(rules[1].name, 'allow-low');
    });

    it('multi-policy: allow from one policy applies even when other policy has no match', async () => {
      const agent = await agentsDAO.create({ name: 'partial-bot', description: '' });
      const policyA = await dao.create({ name: 'example-allow', description: '' });
      const policyB = await dao.create({ name: 'google-deny', description: '' });
      await dao.assignToAgent(policyA.id, agent.id);
      await dao.assignToAgent(policyB.id, agent.id);

      await rulesDAO.create({ name: 'allow-example', url_pattern: '.*example\\.com.*', action: 'allow', priority: 10, policy_id: policyA.id });
      await rulesDAO.create({ name: 'deny-google', url_pattern: '.*google\\.com.*', action: 'deny', priority: 10, policy_id: policyB.id });

      const rules = await dao.resolveAgentRules(agent.id);
      // Both rules present, matching is up to the evaluator
      assert.equal(rules.length, 2);
      const names = rules.map(r => r.name);
      assert.ok(names.includes('allow-example'));
      assert.ok(names.includes('deny-google'));
    });
  });
});
