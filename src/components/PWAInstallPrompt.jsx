import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Download } from "lucide-react";

const ShareIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="17" height="17" style={{ display: "inline", verticalAlign: "middle" }}>
        <polyline points="16 8 12 4 8 8" />
        <line x1="12" y1="4" x2="12" y2="16" />
        <rect x="3" y="14" width="18" height="8" rx="2" />
    </svg>
);

const PWAInstallPrompt = () => {
    const [show, setShow] = useState(false);
    const [platform, setPlatform] = useState(null);
    const [deferredPrompt, setDeferredPrompt] = useState(null);

    useEffect(() => {
        const isStandalone =
            window.matchMedia("(display-mode: standalone)").matches ||
            window.navigator.standalone === true;

        if (isStandalone) return;

        const dismissed = localStorage.getItem("zentrade-pwa-dismissed");
        if (dismissed && Date.now() - parseInt(dismissed) < 7 * 24 * 60 * 60 * 1000) return;

        const ua = navigator.userAgent;
        const isIOS = /iphone|ipad|ipod/i.test(ua) && !/CriOS|FxiOS|OPiOS/i.test(ua);

        if (isIOS) {
            const t = setTimeout(() => {
                setPlatform("ios");
                setShow(true);
            }, 2500);
            return () => clearTimeout(t);
        }

        const onBeforeInstall = (e) => {
            e.preventDefault();
            setDeferredPrompt(e);
            setTimeout(() => {
                setPlatform("android");
                setShow(true);
            }, 2000);
        };

        window.addEventListener("beforeinstallprompt", onBeforeInstall);
        return () => window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    }, []);

    const handleInstall = async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        setDeferredPrompt(null);
        if (outcome === "accepted") setShow(false);
    };

    const handleDismiss = () => {
        localStorage.setItem("zentrade-pwa-dismissed", Date.now().toString());
        setShow(false);
    };

    return (
        <AnimatePresence>
            {show && (
                <>
                    <motion.div
                        className="pwa-overlay"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.25 }}
                        onClick={handleDismiss}
                    />
                    <motion.div
                        className="pwa-prompt"
                        initial={{ y: "110%", opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        exit={{ y: "110%", opacity: 0 }}
                        transition={{ type: "spring", stiffness: 380, damping: 32 }}
                    >
                        <button className="pwa-close" onClick={handleDismiss} aria-label="Dismiss">
                            <X size={17} />
                        </button>

                        <div className="pwa-header">
                            <div className="pwa-icon">
                                <img src="/icon.svg" alt="Zentrade" width="52" height="52" />
                            </div>
                            <div className="pwa-header-text">
                                <span className="pwa-title">Add Zentrade to Home Screen</span>
                                <span className="pwa-subtitle">Instant launch · No browser bar · Full-screen</span>
                            </div>
                        </div>

                        {platform === "ios" ? (
                            <div className="pwa-ios-steps">
                                <div className="pwa-step">
                                    <span className="pwa-step-num">1</span>
                                    <span>Tap the <strong className="pwa-step-icon-label"><ShareIcon /> Share</strong> button in the Safari toolbar</span>
                                </div>
                                <div className="pwa-step">
                                    <span className="pwa-step-num">2</span>
                                    <span>Scroll down and tap <strong>"Add to Home Screen"</strong></span>
                                </div>
                                <div className="pwa-step">
                                    <span className="pwa-step-num">3</span>
                                    <span>Tap <strong>"Add"</strong> — done!</span>
                                </div>
                                <button className="pwa-btn-got-it" onClick={handleDismiss}>
                                    Got it
                                </button>
                            </div>
                        ) : (
                            <div className="pwa-android-actions">
                                <button className="pwa-btn-install" onClick={handleInstall}>
                                    <Download size={15} /> Install App
                                </button>
                                <button className="pwa-btn-later" onClick={handleDismiss}>
                                    Not Now
                                </button>
                            </div>
                        )}
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
};

export default PWAInstallPrompt;
