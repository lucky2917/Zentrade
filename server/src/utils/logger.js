const COLORS = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m",
};

const timestamp = () => {
    return new Date().toISOString();
};

const formatMessage = (level, context, message, data) => {
    const ts = timestamp();
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";
    return `${COLORS.gray}[${ts}]${COLORS.reset} ${level} ${COLORS.cyan}[${context}]${COLORS.reset} ${message}${dataStr}`;
};

const logger = {
    info: (context, message, data) => {
        console.log(formatMessage(`${COLORS.green}INFO${COLORS.reset}`, context, message, data));
    },

    warn: (context, message, data) => {
        console.warn(formatMessage(`${COLORS.yellow}WARN${COLORS.reset}`, context, message, data));
    },

    error: (context, message, data) => {
        console.error(formatMessage(`${COLORS.red}ERROR${COLORS.reset}`, context, message, data));
    },

    trade: (context, message, data) => {
        console.log(formatMessage(`${COLORS.magenta}TRADE${COLORS.reset}`, context, message, data));
    },

    market: (context, message, data) => {
        console.log(formatMessage(`${COLORS.blue}MARKET${COLORS.reset}`, context, message, data));
    },
};

export default logger;

/*
 * custom console logger with color codes so the terminal output
 * is actually readable. has levels for info, warn, error, trade,
 * and market. every server file uses this instead of raw console.log.
 */
