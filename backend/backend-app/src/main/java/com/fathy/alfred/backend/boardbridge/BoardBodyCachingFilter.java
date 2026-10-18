package com.fathy.alfred.backend.boardbridge;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * Keeps a /board write's JSON body readable twice (specs/031): once by the board lock, which needs the board the body
 * names, and once by the controller. Only bodies that say their length and are at most {@link #MAX_BYTES}; anything else
 * (uploads, chunked) passes untouched and the lock judges it by its path.
 */
public class BoardBodyCachingFilter extends OncePerRequestFilter {

    static final int MAX_BYTES = 1024 * 1024;
    static final String CACHED = BoardBodyCachingFilter.class.getName() + ".body";

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String m = request.getMethod();
        String type = request.getContentType();
        String uri = request.getRequestURI();
        return "GET".equals(m) || "HEAD".equals(m) || "OPTIONS".equals(m) || uri == null || !uri.startsWith("/board/")
                || type == null || !type.toLowerCase(java.util.Locale.ROOT).contains("json")
                || request.getContentLengthLong() < 0 || request.getContentLengthLong() > MAX_BYTES;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        byte[] body = request.getInputStream().readNBytes(MAX_BYTES + 1);
        request.setAttribute(CACHED, body);
        chain.doFilter(new Cached(request, body), response);
    }

    static final class Cached extends HttpServletRequestWrapper {

        private final byte[] body;

        Cached(HttpServletRequest request, byte[] body) {
            super(request);
            this.body = body;
        }

        @Override
        public ServletInputStream getInputStream() {
            ByteArrayInputStream in = new ByteArrayInputStream(body);
            return new ServletInputStream() {
                @Override
                public boolean isFinished() {
                    return in.available() == 0;
                }

                @Override
                public boolean isReady() {
                    return true;
                }

                @Override
                public void setReadListener(ReadListener listener) {
                    throw new UnsupportedOperationException();
                }

                @Override
                public int read() {
                    return in.read();
                }

                @Override
                public int read(byte[] b, int off, int len) {
                    return in.read(b, off, len);
                }
            };
        }

        @Override
        public BufferedReader getReader() {
            String enc = getCharacterEncoding();
            return new BufferedReader(new InputStreamReader(getInputStream(),
                    enc == null ? StandardCharsets.UTF_8 : java.nio.charset.Charset.forName(enc)));
        }
    }
}
