// Shared framer-motion variants — tuned for an Apple-like feel:
// slightly larger travel, softer springs, gentle stagger.
export const staggerContainer = {
    hidden: { opacity: 0 },
    show: {
        opacity: 1,
        transition: { staggerChildren: 0.045, delayChildren: 0.04 },
    },
};

export const fadeUpItem = {
    hidden: { opacity: 0, y: 16, filter: "blur(4px)" },
    show: {
        opacity: 1,
        y: 0,
        filter: "blur(0px)",
        transition: { type: "spring", stiffness: 260, damping: 26, mass: 0.9 },
    },
};

export const scaleUpItem = {
    hidden: { opacity: 0, scale: 0.94 },
    show: { opacity: 1, scale: 1, transition: { type: "spring", stiffness: 280, damping: 24 } },
};

export const scaleFadeUpItem = {
    hidden: { opacity: 0, scale: 0.96, y: 14 },
    show: { opacity: 1, scale: 1, y: 0, transition: { type: "spring", stiffness: 260, damping: 25 } },
};

// Full-page entrance — used by top-level page wrappers
export const pageEnter = {
    initial: { opacity: 0, y: 18, filter: "blur(6px)" },
    animate: { opacity: 1, y: 0, filter: "blur(0px)" },
    transition: { duration: 0.5, ease: [0.16, 1, 0.3, 1] },
};
