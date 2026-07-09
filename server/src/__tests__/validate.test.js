import { describe, it, expect, vi } from "vitest";
import { validate, required, isEmail, minLength, positiveInt } from "../middleware/validate.js";

const runMiddleware = (schema, body) => {
    const req = { body };
    const res = {
        statusCode: null,
        payload: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    };
    const next = vi.fn();
    validate(schema)(req, res, next);
    return { res, next };
};

describe("validate middleware", () => {
    it("calls next when all rules pass", () => {
        const { res, next } = runMiddleware(
            { email: [required, isEmail], password: [required, minLength(8)] },
            { email: "user@example.com", password: "longenough" }
        );
        expect(next).toHaveBeenCalledOnce();
        expect(res.statusCode).toBeNull();
    });

    it("returns 400 with the first failing rule's message", () => {
        const { res, next } = runMiddleware(
            { email: [required, isEmail] },
            { email: "not-an-email" }
        );
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.payload.error).toBe("Invalid email format");
    });

    it("does not crash when req.body is undefined (no JSON body sent)", () => {
        const { res, next } = runMiddleware({ email: [required] }, undefined);
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(400);
        expect(res.payload.error).toBe("email is required");
    });
});

describe("validation rules", () => {
    it("required rejects undefined, null and empty string", () => {
        expect(required(undefined, "f")).toBe("f is required");
        expect(required(null, "f")).toBe("f is required");
        expect(required("", "f")).toBe("f is required");
        expect(required(0, "f")).toBeNull();
        expect(required("x", "f")).toBeNull();
    });

    it("isEmail accepts valid addresses and rejects invalid ones", () => {
        expect(isEmail("user@example.com")).toBeNull();
        expect(isEmail("user.name+tag@sub.domain.co")).toBeNull();
        expect(isEmail("plainstring")).toBe("Invalid email format");
        expect(isEmail("a@b@c.com")).toBe("Invalid email format");
    });

    it("minLength enforces the minimum", () => {
        expect(minLength(8)("1234567", "password")).toBe("password must be at least 8 characters");
        expect(minLength(8)("12345678", "password")).toBeNull();
    });

    it("positiveInt rejects zero, negatives, floats and non-numbers", () => {
        expect(positiveInt(0, "quantity")).toBe("quantity must be a positive whole number");
        expect(positiveInt(-5, "quantity")).toBe("quantity must be a positive whole number");
        expect(positiveInt(1.5, "quantity")).toBe("quantity must be a positive whole number");
        expect(positiveInt("abc", "quantity")).toBe("quantity must be a positive whole number");
        expect(positiveInt(10, "quantity")).toBeNull();
        expect(positiveInt("10", "quantity")).toBeNull();
    });
});
