import { Component } from "react";

class ErrorBoundary extends Component {
    state = { hasError: false };

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    componentDidCatch(error, info) {
        console.error("Unhandled UI error", error, info);
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="empty-state glass-panel" style={{ margin: "2rem auto", maxWidth: "420px" }}>
                    <h2 style={{ marginBottom: "1rem" }}>Something went wrong</h2>
                    <p style={{ color: "var(--text-muted)", marginBottom: "1.5rem" }}>
                        Please refresh the page. If the problem persists, try again later.
                    </p>
                    <button className="btn-trade" onClick={() => window.location.reload()}>Reload</button>
                </div>
            );
        }
        return this.props.children;
    }
}

export default ErrorBoundary;
