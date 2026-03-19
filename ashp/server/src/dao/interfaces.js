function notImpl(name) { return Promise.reject(new Error(`${name} not implemented`)); }

export class RulesDAO {
  list()             { return notImpl('list'); }
  get(id)            { return notImpl('get'); }
  create(rule)       { return notImpl('create'); }
  update(id, rule)   { return notImpl('update'); }
  delete(id)         { return notImpl('delete'); }
  match(url, method) { return notImpl('match'); }
  incrementHitCount(ruleId) { return notImpl('incrementHitCount'); }
}

export class RequestLogDAO {
  insert(entry)      { return notImpl('insert'); }
  query(filters)     { return notImpl('query'); }
  getById(id)        { return notImpl('getById'); }
  cleanup(olderThan) { return notImpl('cleanup'); }
}

export class ApprovalQueueDAO {
  enqueue(entry)      { return notImpl('enqueue'); }
  resolve(id, action) { return notImpl('resolve'); }
  listPending()       { return notImpl('listPending'); }
}

export class AgentsDAO {
  async list() { throw new Error('Not implemented'); }
  async get(id) { throw new Error('Not implemented'); }
  async create(agent) { throw new Error('Not implemented'); }
  async update(id, fields) { throw new Error('Not implemented'); }
  async delete(id) { throw new Error('Not implemented'); }
  async rotateToken(id) { throw new Error('Not implemented'); }
  async authenticate(name, token) { throw new Error('Not implemented'); }
  async incrementRequestCount(name) { throw new Error('Not implemented'); }
  listForProxy() { throw new Error('Not implemented'); }
}
