import { useEffect, useRef } from 'react';

// Map our tickers to TradingView exchange-qualified symbols for reliable resolution.
const TV_SYMBOL: Record<string, string> = {
  SPY: 'AMEX:SPY', QQQ: 'NASDAQ:QQQ', TSLA: 'NASDAQ:TSLA', META: 'NASDAQ:META',
  MSFT: 'NASDAQ:MSFT', AMD: 'NASDAQ:AMD', NVDA: 'NASDAQ:NVDA', AAPL: 'NASDAQ:AAPL',
  AMZN: 'NASDAQ:AMZN', GOOGL: 'NASDAQ:GOOGL', IWM: 'AMEX:IWM', CEG: 'NASDAQ:CEG',
  MU: 'NASDAQ:MU', DIA: 'AMEX:DIA', XLE: 'AMEX:XLE', GLD: 'AMEX:GLD',
  // Continuous futures (real overnight charts) — leading indicators for the ETFs.
  'ES=F': 'CME_MINI:ES1!', 'NQ=F': 'CME_MINI:NQ1!', 'YM=F': 'CBOT_MINI:YM1!',
  'RTY=F': 'CME_MINI:RTY1!', 'CL=F': 'NYMEX:CL1!', 'GC=F': 'COMEX:GC1!',
  // Crypto — TRACKED as macro indicators only (never traded; risk engine blocks orders).
  BTC: 'COINBASE:BTCUSD', ETH: 'COINBASE:ETHUSD', 'BTC-USD': 'COINBASE:BTCUSD', 'ETH-USD': 'COINBASE:ETHUSD',
};

export default function TradingViewChart({ symbol, height = 480 }: { symbol: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '';
    const tvSymbol = TV_SYMBOL[symbol] || symbol;
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: tvSymbol,
      interval: 'D',
      timezone: 'America/Los_Angeles',
      theme: 'dark',
      // Area style (3) reads closest to the Robinhood single-line look.
      style: '3',
      locale: 'en',
      backgroundColor: '#0b0e11',
      gridColor: 'rgba(35,42,52,0.35)',
      // Robinhood green/red up/down semantics across candles, volume & area.
      overrides: {
        'mainSeriesProperties.candleStyle.upColor': '#00C805',
        'mainSeriesProperties.candleStyle.downColor': '#FF5000',
        'mainSeriesProperties.candleStyle.borderUpColor': '#00C805',
        'mainSeriesProperties.candleStyle.borderDownColor': '#FF5000',
        'mainSeriesProperties.candleStyle.wickUpColor': '#00C805',
        'mainSeriesProperties.candleStyle.wickDownColor': '#FF5000',
        'mainSeriesProperties.areaStyle.color1': 'rgba(0,200,5,0.18)',
        'mainSeriesProperties.areaStyle.color2': 'rgba(0,200,5,0.0)',
        'mainSeriesProperties.areaStyle.linecolor': '#00C805',
        'mainSeriesProperties.lineStyle.color': '#00C805',
        'paneProperties.background': '#0b0e11',
        'paneProperties.backgroundType': 'solid',
        'paneProperties.vertGridProperties.color': 'rgba(35,42,52,0.35)',
        'paneProperties.horzGridProperties.color': 'rgba(35,42,52,0.35)',
      },
      // Minimal chrome for the clean Robinhood feel.
      hide_top_toolbar: true,
      hide_legend: true,
      hide_volume: true,
      allow_symbol_change: true,
      withdateranges: true,
      studies: [],
      support_host: 'https://www.tradingview.com',
    });
    // If the third-party widget is blocked/offline, show a link instead of a blank box.
    script.onerror = () => {
      el.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#8b95a5;font-size:13px">Chart unavailable — <a href="https://www.tradingview.com/symbols/${encodeURIComponent(tvSymbol)}/" target="_blank" rel="noreferrer" style="margin-left:4px">open ${symbol} on TradingView ↗</a></div>`;
    };
    el.appendChild(script);
  }, [symbol]);

  return (
    <div className="tradingview-widget-container" style={{ height, width: '100%' }}>
      <div ref={ref} style={{ height: '100%', width: '100%' }} />
    </div>
  );
}
