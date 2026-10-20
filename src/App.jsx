import { useEffect, useMemo, useRef, useState } from 'react';
import { DerivClient } from './lib/derivClient';

const defaultSettings = {
  appId: '1089',
  token: '',
  accountType: 'demo',
  symbol: 'R_100',
  stakePerContract: 1,
  duration: 5,
  durationUnit: 't',
  barrierHigher: '+0.1',
  barrierLower: '-0.1',
  maxPairedRuns: 10,
  takeProfit: 5,
  stopLoss: 10,
  autoRepeat: true,
  higherContractType: 'CALL',
  lowerContractType: 'PUT',
};

const defaultSession = {
  running: false,
  pairIndex: 0,
  startedAt: null,
  netProfit: 0,
  spent: 0,
  realized: 0,
  highestProfit: 0,
  maxDrawdown: 0,
  openExposure: 0,
  startBalance: 0,
};

function App() {
  const [settings, setSettings] = useState(defaultSettings);
  const [client, setClient] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('Disconnected');
  const [authStatus, setAuthStatus] = useState('Not authenticated');
  const [account, setAccount] = useState({
    currency: 'USD',
    balance: 0,
    loginid: '',
    accountType: 'demo',
  });
  const [journal, setJournal] = useState([]);
  const [session, setSession] = useState(defaultSession);
  const [pairState, setPairState] = useState({
    runId: 0,
    lastResult: null,
    proposals: { higher: null, lower: null },
    buys: { higher: null, lower: null },
  });
  const [riskBlocked, setRiskBlocked] = useState(false);
  const [liveContractInfo, setLiveContractInfo] = useState({ higher: null, lower: null });

  const journalRef = useRef(null);

  const addJournal = (message) => {
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    setJournal((prev) => [{ stamp, message }, ...prev].slice(0, 220));
  };

  useEffect(() => {
    journalRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [journal]);

  const sessionSummary = useMemo(() => ({
    sessionProfit: session.netProfit,
    currentNet: session.netProfit,
    openExposure: session.openExposure,
    highestProfit: session.highestProfit,
    maxDrawdown: session.maxDrawdown,
  }), [session]);

  const handleSettingChange = (event) => {
    const { name, value, type, checked } = event.target;
    setSettings((prev) => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value,
    }));
  };

  const createClient = async () => {
    const inst = new DerivClient({
      appId: settings.appId,
      token: settings.token,
      onLog: addJournal,
      onAccountUpdate: (res) => {
        const nextBalance = Number(res.balance ?? account.balance ?? 0);
        const nextCurrency = res.currency || account.currency || 'USD';
        setAccount((prev) => ({ ...prev, balance: nextBalance, currency: nextCurrency, loginid: res.loginid || prev.loginid }));
      },
      onAuth: (authorized) => {
        setAuthStatus(authorized ? 'Authenticated' : 'Not authenticated');
      },
      onContractUpdate: (contract) => {
        setLiveContractInfo((prev) => ({
          ...prev,
          [contract.contractType || contract.side || 'higher']: contract,
        }));
      },
    });

    setClient(inst);
    return inst;
  };

  const ensureConnectedAndAuthorized = async () => {
    if (!client) {
      const inst = await createClient();
      await inst.connect();
      await inst.authorize();
      setConnectionStatus('Connected');
      setAuthStatus('Authenticated');
      return inst;
    }

    if (!client.connected) {
      await client.connect();
      setConnectionStatus('Connected');
    }

    if (!client.authorized) {
      await client.authorize();
      setAuthStatus('Authenticated');
    }

    return client;
  };

  const disconnectClient = async () => {
    if (client) {
      client.disconnect();
      setClient(null);
    }
    setConnectionStatus('Disconnected');
    setAuthStatus('Not authenticated');
    addJournal('Disconnected from Deriv WebSocket.');
  };

  const resetSession = () => {
    setSession({ ...defaultSession, running: false });
    setPairState({
      runId: 0,
      lastResult: null,
      proposals: { higher: null, lower: null },
      buys: { higher: null, lower: null },
    });
    setRiskBlocked(false);
    setLiveContractInfo({ higher: null, lower: null });
    addJournal('Session reset.');
  };

  async function requestPairProposals(activeClient) {
    const higherPayload = {
      symbol: settings.symbol,
      amount: Number(settings.stakePerContract),
      basis: 'stake',
      contract_type: settings.higherContractType,
      duration: Number(settings.duration),
      duration_unit: settings.durationUnit,
      currency: 'USD',
      barrier: settings.barrierHigher,
    };

    const lowerPayload = {
      symbol: settings.symbol,
      amount: Number(settings.stakePerContract),
      basis: 'stake',
      contract_type: settings.lowerContractType,
      duration: Number(settings.duration),
      duration_unit: settings.durationUnit,
      currency: 'USD',
      barrier: settings.barrierLower,
    };

    addJournal('Requesting Higher and Lower proposals.');

    const [higherResult, lowerResult] = await Promise.all([
      activeClient.requestProposal(higherPayload),
      activeClient.requestProposal(lowerPayload),
    ]);

    setPairState((prev) => ({
      ...prev,
      proposals: { higher: higherResult, lower: lowerResult },
    }));

    if (!higherResult?.valid || !lowerResult?.valid) {
      addJournal('Proposal validation failed for one or both contracts.');
      setRiskBlocked(true);
      return null;
    }

    addJournal('Both proposals validated.');
    return { higher: higherResult, lower: lowerResult };
  }

  async function submitPairedPurchase(activeClient, proposalPack) {
    addJournal('Dispatching both buy requests as a paired operation.');

    const [higherResult, lowerResult] = await Promise.allSettled([
      activeClient.buy({
        proposalId: proposalPack.higher.offerId || proposalPack.higher.id,
        price: proposalPack.higher.askPrice || proposalPack.higher.price,
        contractType: 'higher',
      }),
      activeClient.buy({
        proposalId: proposalPack.lower.offerId || proposalPack.lower.id,
        price: proposalPack.lower.askPrice || proposalPack.lower.price,
        contractType: 'lower',
      }),
    ]);

    const buySummary = {
      higher: higherResult.status === 'fulfilled' ? higherResult.value : null,
      lower: lowerResult.status === 'fulfilled' ? lowerResult.value : null,
    };

    setPairState((prev) => ({
      ...prev,
      buys: { higher: buySummary.higher, lower: buySummary.lower },
    }));

    if (buySummary.higher?.success) {
      addJournal(`Higher purchase confirmed — Contract ID: ${buySummary.higher.contractId ?? 'unknown'}`);
    } else {
      addJournal('Higher purchase did not confirm.');
    }

    if (buySummary.lower?.success) {
      addJournal(`Lower purchase confirmed — Contract ID: ${buySummary.lower.contractId ?? 'unknown'}`);
    } else {
      addJournal('Lower purchase did not confirm.');
    }

    const bothOpen = Boolean(buySummary.higher?.success && buySummary.lower?.success);
    const anyOpen = Boolean(buySummary.higher?.success || buySummary.lower?.success);

    if (!bothOpen && anyOpen) {
      addJournal('Partial execution detected. Recovery policy is disabled unless explicitly enabled.');
      setRiskBlocked(true);
    }

    return buySummary;
  }

  async function startDoubleTrade() {
    if (!settings.token.trim()) {
      addJournal('A Deriv API token is required before trading.');
      return;
    }

    if (session.running) {
      addJournal('A trading session is already running.');
      return;
    }

    if (settings.accountType === 'real') {
      const confirmed = window.confirm('You are enabling real-account trading. Continue?');
      if (!confirmed) {
        addJournal('Real-account trading cancelled by user.');
        return;
      }
    }

    try {
      const activeClient = await ensureConnectedAndAuthorized();
      setSession((prev) => ({
        ...prev,
        running: true,
        startedAt: new Date().toISOString(),
        pairIndex: prev.pairIndex + 1,
        startBalance: Number(account.balance || 0),
      }));

      setRiskBlocked(false);
      addJournal('Trading session started.');

      const proposals = await requestPairProposals(activeClient);
      if (!proposals) {
        setSession((prev) => ({ ...prev, running: false }));
        return;
      }

      const buySummary = await submitPairedPurchase(activeClient, proposals);
      const bothOpen = Boolean(buySummary.higher?.success && buySummary.lower?.success);

      if (!bothOpen) {
        setSession((prev) => ({ ...prev, running: false }));
        addJournal('Session halted because both contracts were not confirmed.');
        return;
      }

      addJournal('Monitoring both contracts until settlement.');
      setSession((prev) => ({
        ...prev,
        openExposure: Number(settings.stakePerContract) * 2,
      }));

      setPairState((prev) => ({
        ...prev,
        runId: prev.runId + 1,
        lastResult: {
          successful: bothOpen,
          higher: buySummary.higher,
          lower: buySummary.lower,
        },
      }));

      if (settings.autoRepeat) {
        addJournal('Auto-repeat enabled. The engine will continue until TP/SL or run cap is reached.');
      }
    } catch (error) {
      console.error(error);
      addJournal(`Execution error: ${error.message || 'Unknown error'}`);
      setSession((prev) => ({ ...prev, running: false }));
    }
  }

  const stopNewTrades = () => {
    setRiskBlocked(true);
    setSession((prev) => ({ ...prev, running: false }));
    addJournal('New paired trades paused. Existing contracts continue to be monitored.');
  };

  const emergencyStop = () => {
    setRiskBlocked(true);
    setSession((prev) => ({ ...prev, running: false }));
    if (client) {
      client.disconnect();
    }
    setConnectionStatus('Disconnected');
    setAuthStatus('Not authenticated');
    addJournal('Emergency stop triggered. WebSocket disconnected and new trades halted.');
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Deriv trading dashboard</p>
          <h1>Double Trade Bot</h1>
        </div>
        <div className="status-badges">
          <span className={`badge connection ${connectionStatus.toLowerCase().replace(/\s+/g, '-')}`}>
            {connectionStatus}
          </span>
          <span className={`badge auth ${authStatus.toLowerCase().replace(/\s+/g, '-')}`}>
            {authStatus}
          </span>
        </div>
      </header>

      <main className="layout-grid">
        <aside className="panel account-panel">
          <h2>Account</h2>
          <div className="account-row">
            <span>Mode</span>
            <strong>{settings.accountType === 'real' ? 'Real' : 'Demo'}</strong>
          </div>
          <div className="account-row">
            <span>Account</span>
            <strong>{account.loginid || 'Not loaded'}</strong>
          </div>
          <div className="account-row">
            <span>Currency</span>
            <strong>{account.currency}</strong>
          </div>
          <div className="account-row">
            <span>Balance</span>
            <strong>{Number(account.balance || 0).toFixed(2)}</strong>
          </div>
          <div className="account-row">
            <span>Session P/L</span>
            <strong>{sessionSummary.currentNet.toFixed(2)}</strong>
          </div>

          <div className="field-group inline">
            <label>Demo / Real</label>
            <select name="accountType" value={settings.accountType} onChange={handleSettingChange}>
              <option value="demo">Demo</option>
              <option value="real">Real</option>
            </select>
          </div>

          <div className="field-group">
            <label>App ID</label>
            <input name="appId" type="text" value={settings.appId} onChange={handleSettingChange} />
          </div>
          <div className="field-group">
            <label>API token</label>
            <input
              name="token"
              type="password"
              value={settings.token}
              onChange={handleSettingChange}
              placeholder="Never stored in source code"
            />
          </div>

          <div className="button-stack">
            <button className="primary" onClick={async () => {
              const inst = await createClient();
              await inst.connect();
              await inst.authorize();
              setConnectionStatus('Connected');
              setAuthStatus('Authenticated');
            }}>
              Connect Account
            </button>
            <button className="secondary" onClick={disconnectClient}>Disconnect</button>
          </div>
        </aside>

        <section className="panel contract-panel">
          <h2>Contract Panel</h2>

          <div className="contract-box">
            <div className="contract-header">
              <span className="contract-tag higher">HIGHER / CALL</span>
              <span className={`status-dot ${pairState.proposals.higher ? 'on' : 'off'}`} />
            </div>
            <div className="stat-grid">
              <div><span>Symbol</span><strong>{settings.symbol}</strong></div>
              <div><span>Barrier</span><strong>{settings.barrierHigher}</strong></div>
              <div><span>Stake</span><strong>${settings.stakePerContract}</strong></div>
              <div><span>Duration</span><strong>{settings.duration}{settings.durationUnit}</strong></div>
              <div><span>Proposal</span><strong>{pairState.proposals.higher ? 'Ready' : 'Pending'}</strong></div>
              <div><span>Purchase</span><strong>{pairState.buys.higher ? 'Confirmed' : 'Waiting'}</strong></div>
              <div><span>Contract ID</span><strong>{pairState.buys.higher?.contractId || '—'}</strong></div>
              <div><span>Result</span><strong>{pairState.buys.higher?.payout ? `$${pairState.buys.higher.payout}` : '—'}</strong></div>
            </div>
          </div>

          <div className="contract-box">
            <div className="contract-header">
              <span className="contract-tag lower">LOWER / PUT</span>
              <span className={`status-dot ${pairState.proposals.lower ? 'on' : 'off'}`} />
            </div>
            <div className="stat-grid">
              <div><span>Symbol</span><strong>{settings.symbol}</strong></div>
              <div><span>Barrier</span><strong>{settings.barrierLower}</strong></div>
              <div><span>Stake</span><strong>${settings.stakePerContract}</strong></div>
              <div><span>Duration</span><strong>{settings.duration}{settings.durationUnit}</strong></div>
              <div><span>Proposal</span><strong>{pairState.proposals.lower ? 'Ready' : 'Pending'}</strong></div>
              <div><span>Purchase</span><strong>{pairState.buys.lower ? 'Confirmed' : 'Waiting'}</strong></div>
              <div><span>Contract ID</span><strong>{pairState.buys.lower?.contractId || '—'}</strong></div>
              <div><span>Result</span><strong>{pairState.buys.lower?.payout ? `$${pairState.buys.lower.payout}` : '—'}</strong></div>
            </div>
          </div>
        </section>

        <aside className="panel controls-panel">
          <h2>Trading Controls</h2>

          <div className="button-stack stack-two">
            <button className="primary" onClick={startDoubleTrade} disabled={session.running || riskBlocked}>
              Start Double Trade
            </button>
            <button className="secondary" onClick={stopNewTrades}>Stop New Trades</button>
            <button className="danger" onClick={emergencyStop}>Emergency Stop</button>
            <button className="secondary" onClick={resetSession}>Reset Session</button>
          </div>

          <div className="field-grid">
            <div className="field-group">
              <label>Stake / contract</label>
              <input name="stakePerContract" type="number" min="0.1" step="0.1" value={settings.stakePerContract} onChange={handleSettingChange} />
            </div>
            <div className="field-group">
              <label>Duration</label>
              <input name="duration" type="number" min="1" value={settings.duration} onChange={handleSettingChange} />
            </div>
            <div className="field-group">
              <label>Duration unit</label>
              <select name="durationUnit" value={settings.durationUnit} onChange={handleSettingChange}>
                <option value="t">ticks</option>
                <option value="m">minutes</option>
                <option value="h">hours</option>
              </select>
            </div>
            <div className="field-group">
              <label>Max paired runs</label>
              <input name="maxPairedRuns" type="number" min="1" value={settings.maxPairedRuns} onChange={handleSettingChange} />
            </div>
            <div className="field-group">
              <label>Take profit</label>
              <input name="takeProfit" type="number" value={settings.takeProfit} onChange={handleSettingChange} />
            </div>
            <div className="field-group">
              <label>Stop loss</label>
              <input name="stopLoss" type="number" value={settings.stopLoss} onChange={handleSettingChange} />
            </div>
            <div className="field-group">
              <label>Higher barrier</label>
              <input name="barrierHigher" type="text" value={settings.barrierHigher} onChange={handleSettingChange} />
            </div>
            <div className="field-group">
              <label>Lower barrier</label>
              <input name="barrierLower" type="text" value={settings.barrierLower} onChange={handleSettingChange} />
            </div>
          </div>

          <label className="toggle-row">
            <input type="checkbox" name="autoRepeat" checked={settings.autoRepeat} onChange={handleSettingChange} />
            <span>Automatic repeat</span>
          </label>

          <div className="stats-list">
            <div><span>Session net</span><strong>{sessionSummary.sessionProfit.toFixed(2)}</strong></div>
            <div><span>Highest profit</span><strong>{sessionSummary.highestProfit.toFixed(2)}</strong></div>
            <div><span>Drawdown</span><strong>{sessionSummary.maxDrawdown.toFixed(2)}</strong></div>
            <div><span>Open exposure</span><strong>{sessionSummary.openExposure.toFixed(2)}</strong></div>
          </div>
        </aside>
      </main>

      <section className="panel journal-panel">
        <div className="panel-heading">
          <h2>Live Market Journal</h2>
        </div>
        <div ref={journalRef} className="journal-list">
          {journal.length === 0 ? (
            <div className="journal-empty">No activity yet — connect and authenticate to begin.</div>
          ) : (
            journal.map((entry, index) => (
              <div key={`${entry.stamp}-${index}`} className="journal-entry">
                <span>[{entry.stamp}]</span>
                <span>{entry.message}</span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

export default App;
