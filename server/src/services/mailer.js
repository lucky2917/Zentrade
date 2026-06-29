import nodemailer from "nodemailer";
import logger from "../utils/logger.js";

let transporter = null;

const getTransporter = () => {
    if (transporter) return transporter;
    if (!process.env.WATCHDOG_GMAIL_USER || !process.env.WATCHDOG_GMAIL_PASS) return null;

    transporter = nodemailer.createTransport({
        host: "smtp.mail.me.com",
        port: 587,
        secure: false,
        auth: {
            user: process.env.WATCHDOG_GMAIL_USER,
            pass: process.env.WATCHDOG_GMAIL_PASS,
        },
    });
    return transporter;
};

const sendMail = async (to, subject, html) => {
    const transport = getTransporter();
    if (!transport) {
        logger.warn("Mailer", "Gmail not configured, skipping email", { to, subject });
        return false;
    }

    try {
        await transport.sendMail({ from: process.env.WATCHDOG_GMAIL_USER, to, subject, html });
        logger.info("Mailer", `Email sent: ${subject}`);
        return true;
    } catch (err) {
        logger.error("Mailer", "Failed to send email", { error: err.message, subject });
        return false;
    }
};

export { sendMail };
