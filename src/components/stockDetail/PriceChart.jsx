import { useEffect, useRef } from "react";
import { createChart, CandlestickSeries, HistogramSeries } from "lightweight-charts";
import { BarChart2 } from "lucide-react";

const RANGES = [
    { key: "1d", label: "1D" },
    { key: "5d", label: "5D" },
    { key: "1mo", label: "1M" },
    { key: "3mo", label: "3M" },
    { key: "1y", label: "1Y" },
    { key: "5y", label: "5Y" },
];

const ChartCanvas = ({ chartData, selectedRange }) => {
    const wrapperRef = useRef(null);
    const chartInstanceRef = useRef(null);
    const timerRef = useRef(null);

    useEffect(() => {
        if (!wrapperRef.current || chartData.length === 0) return;

        const wrapper = wrapperRef.current;

        if (chartInstanceRef.current) {
            try {
                window.removeEventListener("resize", chartInstanceRef.current._rh);
                chartInstanceRef.current.remove();
            } catch { /* chart already disposed */ }
            chartInstanceRef.current = null;
        }

        const chartHost = document.createElement("div");
        chartHost.style.width = "100%";
        chartHost.style.height = "420px";
        wrapper.innerHTML = "";
        wrapper.appendChild(chartHost);

        timerRef.current = setTimeout(() => {
            if (!wrapper.isConnected) return;

            const w = chartHost.offsetWidth || wrapper.offsetWidth || 600;

            const chart = createChart(chartHost, {
                width: w,
                height: 420,
                layout: {
                    background: { color: "transparent" },
                    textColor: "#636366",
                },
                grid: {
                    vertLines: { color: "var(--border)" },
                    horzLines: { color: "var(--border)" },
                },
                timeScale: {
                    timeVisible: selectedRange === "1d" || selectedRange === "5d",
                    secondsVisible: false,
                },
            });

            const cs = chart.addSeries(CandlestickSeries, {
                upColor: "#30d158",
                downColor: "#ff3b30",
                borderDownColor: "#ff3b30",
                borderUpColor: "#30d158",
                wickDownColor: "#ff3b30",
                wickUpColor: "#30d158",
            });

            const vs = chart.addSeries(HistogramSeries, {
                priceFormat: { type: "volume" },
                priceScaleId: "vol",
            });

            chart.priceScale("vol").applyOptions({
                scaleMargins: { top: 0.85, bottom: 0 },
            });

            const IST_OFFSET = 19800; // 5.5 hours in seconds for IST

            const candles = chartData
                .filter((c) => c.open != null && c.close != null && c.high != null && c.low != null)
                .map((c) => ({ time: c.time + IST_OFFSET, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));

            const vols = chartData
                .filter((c) => c.close != null && c.open != null)
                .map((c) => ({
                    time: c.time + IST_OFFSET,
                    value: +(c.volume || 0),
                    color: c.close >= c.open ? "rgba(48,209,88,0.3)" : "rgba(255,59,48,0.3)",
                }));

            cs.setData(candles);
            vs.setData(vols);
            chart.timeScale().fitContent();

            const rh = () => {
                if (chartInstanceRef.current && chartHost.offsetWidth > 0) {
                    chartInstanceRef.current.applyOptions({ width: chartHost.offsetWidth });
                }
            };
            window.addEventListener("resize", rh);
            chart._rh = rh;
            chartInstanceRef.current = chart;
        }, 150);

        return () => {
            clearTimeout(timerRef.current);
            if (chartInstanceRef.current) {
                try {
                    window.removeEventListener("resize", chartInstanceRef.current._rh);
                    chartInstanceRef.current.remove();
                } catch { /* chart already disposed */ }
                chartInstanceRef.current = null;
            }
        };
    }, [chartData, selectedRange]);

    return <div ref={wrapperRef} style={{ width: "100%", minHeight: "420px" }}></div>;
};

const PriceChart = ({ chartData, chartLoading, selectedRange, onRangeChange }) => (
    <div className="chart-section">
        <div className="chart-header">
            <h3><BarChart2 size={16} className="mr-2" /> Price Chart</h3>
            <div className="range-selector">
                {RANGES.map((r) => (
                    <button
                        key={r.key}
                        className={`range-btn ${selectedRange === r.key ? "active" : ""}`}
                        onClick={() => onRangeChange(r.key)}
                    >
                        {r.label}
                    </button>
                ))}
            </div>
        </div>
        {chartLoading ? (
            <div className="chart-loading">Loading chart...</div>
        ) : chartData.length === 0 ? (
            <div className="chart-loading">No chart data available</div>
        ) : (
            <ChartCanvas chartData={chartData} selectedRange={selectedRange} />
        )}
    </div>
);

export default PriceChart;
