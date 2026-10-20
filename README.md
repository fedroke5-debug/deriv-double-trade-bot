export class DerivClient {
  constructor({ appId = '1089', token = '', onLog, onAccountUpdate, onAuth, onContractUpdate } = {}) {
    this.appId = appId;
    this.token = token;
    this.connected = false;
    this.authorized = false;
    this.socket = null;
    this.pending = new Map();
    this.sequence = 1;
    this.onLog = onLog || (() => {});
    this.onAccountUpdate = onAccountUpdate || (() => {});
    this.onAuth = onAuth || (() => {});
    this.onContractUpdate = onContractUpdate || (() => {});
  }

  buildUrl() {
    return `wss://ws.derivws.com/websockets/v3?app_id=${this.appId}`;
  }

  connect() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.connected = true;
      return Promise.resolve(this.socket);
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.buildUrl());
      this.socket = ws;

      const finalize = (event) => {
        this.connected = true;
        this.onLog('Connected to Deriv API.');
        resolve(ws);
      };

      ws.addEventListener('open', finalize);
      ws.addEventListener('error', (event) => {
        this.connected = false;
        this.onLog('WebSocket error occurred.');
        reject(event);
      });
      ws.addEventListener('message', (event) => {
        this.handleMessage(event.data);
      });
      ws.addEventListener('close', () => {
        this.connected = false;
        this.authorized = false;
        this.onLog('WebSocket disconnected.');
      });
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.connected = false;
    this.authorized = false;
  }

  send(payload) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected.');
    }

    const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.socket.send(json);
  }

  async authorize() {
    if (!this.token) {
      throw new Error('A valid Deriv token is required.');
    }

    const tokenRequest = { authorize: this.token };
    const response = await this.sendRequest(tokenRequest);
    this.authorized = Boolean(response && response.authorize);
    this.onAuth(this.authorized);
    this.onLog(this.authorized ? 'Demo account authenticated.' : 'Authentication failed.');
    return response;
  }

  sendRequest(payload) {
    const requestId = this.sequence++;
    const envelope = { id: requestId, ...payload };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Request timed out: ${JSON.stringify(payload)}`));
      }, 15000);

      this.pending.set(requestId, { resolve, reject, timer });
      this.send(envelope);
    });
  }

  requestProposal(payload) {
    return this.sendRequest({ proposal: 1, ...payload });
  }

  buy({ proposalId, price, contractType }) {
    return this.sendRequest({
      buy: 1,
      buy_params: {
        proposal: proposalId,
        price: Number(price),
      },
      contract_type: contractType,
    }).then((response) => {
      const result = response?.buy || response?.buy_result || response;
      const success = Boolean(result?.contract_id || result?.contractId);
      const normalized = {
        success,
        contractId: result?.contract_id || result?.contractId || null,
        payout: result?.payout || result?.payout_value || null,
        askPrice: price,
      };
      return normalized;
    });
  }

  subscribeContract({ contractId, contractType }) {
    const payload = {
      contract_update: 1,
      contract_id: contractId,
      contract_type: contractType,
    };
    this.send(payload);
    this.onLog(`Monitoring contract ${contractId} (${contractType}).`);
    return payload;
  }

  handleMessage(rawMessage) {
    const data = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;

    if (!data) return;

    if (data.error) {
      this.onLog(`API error: ${data.error.message || JSON.stringify(data.error)}`);
      return;
    }

    const requestId = data.id;
    if (requestId && this.pending.has(requestId)) {
      const pending = this.pending.get(requestId);
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(data);
      return;
    }

    if (data.authorize) {
      const authorized = Boolean(data.authorize && data.authorize.loginid);
      this.authorized = authorized;
      this.onAuth(authorized);
      this.onAccountUpdate(data.authorize || {});
      this.onLog(`Account payload received: ${data.authorize?.loginid || 'unknown'}`);
      return;
    }

    if (data.balance) {
      this.onAccountUpdate(data.balance);
      this.onLog('Balance updated.');
      return;
    }

    if (data.proposal) {
      const proposal = data.proposal || {};
      const normalized = {
        valid: proposal.valid !== false,
        offerId: proposal.id || proposal.offer_id || null,
        askPrice: proposal.ask_price || proposal.askPrice || null,
        price: proposal.ask_price || proposal.askPrice || null,
      };
      this.onLog(`Proposal response received: ${normalized.valid ? 'valid' : 'rejected'}`);
      return;
    }

    if (data.buy) {
      const buyInfo = data.buy || {};
      const normalized = {
        success: Boolean(buyInfo.contract_id || buyInfo.contractId),
        contractId: buyInfo.contract_id || buyInfo.contractId || null,
        payout: buyInfo.payout || buyInfo.payout_value || null,
      };
      this.onContractUpdate({ ...normalized, contractType: buyInfo.contract_type || 'unknown' });
      this.onLog(`Purchase response received for contract ${normalized.contractId || 'unknown'}`);
      return;
    }

    if (data.contract_update) {
      const contract = data.contract_update || {};
      this.onContractUpdate({
        contractId: contract.contract_id || contract.id || null,
        contractType: contract.contract_type || contract.side || 'unknown',
        status: contract.status || 'unknown',
        payout: contract.payout || null,
      });
      return;
    }

    if (data.echo_req) {
      return;
    }

    if (data.error) {
      this.onLog(`API error: ${data.error.message || JSON.stringify(data.error)}`);
    }
  }
}
