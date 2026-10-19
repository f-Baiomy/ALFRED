package com.fathy.alfred.backend.links.application.port.in;

/**
 * A request this slice refuses, with the code the page shows and the HTTP status the controller answers with. Never a
 * stack trace: offline, unknown and refused are states the user can act on.
 */
public class LinksProblem extends RuntimeException {

    private final String code;
    private final int status;

    public LinksProblem(String code, int status, String message) {
        super(message);
        this.code = code;
        this.status = status;
    }

    public String code() {
        return code;
    }

    public int status() {
        return status;
    }

    public static LinksProblem notFound(String what) {
        return new LinksProblem("NOT_FOUND", 404, what + " was not found");
    }

    public static LinksProblem bad(String message) {
        return new LinksProblem("BAD_REQUEST", 400, message);
    }

    public static LinksProblem conflict(String code, String message) {
        return new LinksProblem(code, 409, message);
    }

    public static LinksProblem forbidden(String code, String message) {
        return new LinksProblem(code, 403, message);
    }
}
