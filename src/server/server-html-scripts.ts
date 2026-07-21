// Inline JS script builders for dev-mode HTML shells.
// Each function returns a JS string to embed inside <script type="module">.

/** Dev reload WebSocket — live reload on file changes. Shared by AIO + React dev modes. */
export function devWsScript(): string {
  return `
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const _tk = new URLSearchParams(location.search).get('token')
    const _wsUrl = proto + '//' + location.host + '/ws' + (_tk ? '?token=' + encodeURIComponent(_tk) : '')
    let _bootId = null
    function _devWs() {
      const ws = new WebSocket(_wsUrl)
      // v2 envelope (B4b): every frame is {v:2,t,d}
      ws.onmessage = ev => {
        if (typeof ev.data !== 'string' || ev.data[0] !== '{') return
        let f; try { f = JSON.parse(ev.data) } catch { return }
        if (!f || f.v !== 2) return
        if (f.t === 'graph-error' || f.t === 'graph-clear') { ws.close(); location.reload(); return }
        if (f.t === 'reload') { ws.close(); location.reload() }
        else if (f.t === 'css') {
          document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
            if (link.href.startsWith(location.origin)) link.href = link.href.split('?')[0] + '?t=' + Date.now()
          })
        } else if (f.t === 'boot') {
          const id = f.d && f.d.id
          if (_bootId && _bootId !== id) { ws.close(); location.reload() }
          _bootId = id
        }
      }
      ws.onclose = () => setTimeout(_devWs, 2000)
      ws.onerror = (e) => console.warn('[aio] reload WS error:', e)
      ws.onopen = () => console.debug('[aio] reload WS connected')
    }
    _devWs()`;
}

/** React error boundary class — catches render errors, auto-recovers on state update. */
export function errorBoundaryScript(): string {
  return `
    const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
    let _aioMod = null
    class _AioBoundary extends Component {
      constructor(p) { super(p); this.state = { error: null }; this._unsub = null }
      static getDerivedStateFromError(e) { return { error: e } }
      componentDidCatch(e, info) { console.error('[aio] Render error:', e, info) }
      componentDidMount() {
        if (_aioMod && _aioMod._subscribe) {
          this._unsub = _aioMod._subscribe(() => {
            if (this.state.error) this.setState({ error: null })
          })
        }
      }
      componentWillUnmount() {
        if (this._unsub) { this._unsub(); this._unsub = null }
      }
      render() {
        if (this.state.error) {
          const e = this.state.error
          return createElement('div', { style: {padding:'2rem',font:'13px/1.7 monospace',color:'#ff6b6b',background:'#141414',minHeight:'100vh'} },
            createElement('div', { style: {fontWeight:700,fontSize:'1.1rem',marginBottom:'1rem'} }, '\\u26A0 Render Error'),
            createElement('div', { style: {color:'#f1fa8c',whiteSpace:'pre-wrap',marginBottom:'1rem'} }, String(e.message || e)),
            createElement('div', { style: {color:'#888',fontSize:'11px'} }, 'Waiting for state update to retry\\u2026'),
            createElement('button', {
              style: {marginTop:'1rem',padding:'.4rem 1rem',background:'#2a2a2a',color:'#ccc',border:'1px solid #444',borderRadius:'4px',cursor:'pointer',font:'inherit'},
              onClick: () => this.setState({ error: null })
            }, 'Retry Now')
          )
        }
        return this.props.children
      }
    }`;
}

/** Health overlay dot + panel — displays diagnostic events in bottom-right corner. */
export function healthOverlayScript(): string {
  return `
    // ── Health Overlay ──
    var _diagDot = document.createElement('div')
    Object.assign(_diagDot.style, {position:'fixed',bottom:'12px',right:'12px',zIndex:'99999',width:'8px',height:'8px',borderRadius:'50%',background:'#2a2',cursor:'pointer',display:'none',transition:'background .3s',boxShadow:'0 0 4px rgba(0,0,0,.3)'})
    document.body.appendChild(_diagDot)
    var _diagBadge = document.createElement('div')
    Object.assign(_diagBadge.style, {position:'absolute',top:'-8px',right:'-4px',fontSize:'9px',background:'#e25',color:'#fff',borderRadius:'6px',padding:'0 3px',lineHeight:'14px',display:'none'})
    _diagDot.appendChild(_diagBadge)
    var _diagPanel = document.createElement('div')
    Object.assign(_diagPanel.style, {position:'fixed',bottom:'28px',right:'12px',zIndex:'99998',width:'400px',maxHeight:'300px',overflow:'auto',background:'#1a1a1a',border:'1px solid #333',borderRadius:'8px',font:'12px/1.6 monospace',color:'#ccc',display:'none',boxShadow:'0 4px 16px rgba(0,0,0,.5)'})
    document.body.appendChild(_diagPanel)
    var _diagEvents = [], _diagUnread = 0
    _diagDot.onclick = function() {
      var show = _diagPanel.style.display === 'none'
      _diagPanel.style.display = show ? 'block' : 'none'
      if (show) { _diagUnread = 0; _updateDiagDot() }
    }
    function _updateDiagDot() {
      var hasErr = _diagEvents.some(function(e) { return e.severity === 'error' })
      var hasWarn = _diagEvents.some(function(e) { return e.severity === 'warning' })
      _diagDot.style.background = hasErr ? '#e25' : hasWarn ? '#ea0' : '#2a2'
      _diagBadge.style.display = _diagUnread > 0 ? 'block' : 'none'
      _diagBadge.textContent = String(_diagUnread)
    }
    function _renderDiagPanel() {
      var cutoff = Date.now() - 60000
      _diagEvents = _diagEvents.filter(function(e) { return e.ts > cutoff })
      if (!_diagEvents.length) { _diagDot.style.display = 'none'; _diagPanel.style.display = 'none'; return }
      _diagPanel.innerHTML = _diagEvents.map(function(ev) {
        var c = ev.severity === 'error' ? '#e25' : ev.severity === 'warning' ? '#ea0' : '#888'
        var age = Math.round((Date.now() - ev.ts) / 1000)
        return '<div style="padding:6px 10px;border-bottom:1px solid #2a2a2a">'
          + '<span style="color:' + c + '">\\u25CF</span> '
          + '<b>' + esc(ev.type) + '</b> <span style="color:#555">' + age + 's ago</span>'
          + '<div style="color:#aaa;margin:2px 0">' + esc(ev.message) + '</div>'
          + (ev.hint ? '<div style="color:#98c379;font-size:11px">\\u2192 ' + esc(ev.hint) + '</div>' : '')
          + '</div>'
      }).join('')
    }
    window._aioDiag = function(ev) {
      _diagEvents.push(ev)
      _diagUnread++
      _diagDot.style.display = 'block'
      _updateDiagDot()
      if (_diagPanel.style.display !== 'none') _renderDiagPanel()
    }
    setInterval(function() { if (_diagPanel.style.display !== 'none') _renderDiagPanel() }, 10000)`;
}
