import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Download } from "lucide-react";

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

    const handleIOSInstall = async () => {
        try {
            await navigator.share({
                title: "Zentrade",
                url: window.location.href,
            });
        } catch {
            // user cancelled share sheet — do nothing
        }
    };

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
                            <div className="pwa-android-actions">
                                <button className="pwa-btn-install" onClick={handleIOSInstall}>
                                    <Download size={15} /> Install as App
                                </button>
                                <button className="pwa-btn-later" onClick={handleDismiss}>
                                    Not Now
                                </button>
                            </div>
                        ) : (
                            <div className="pwa-android-actions">
                                <button className="pwa-btn-install" onClick={handleInstall}>
                                    <Download size={15} /> Install as App
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
