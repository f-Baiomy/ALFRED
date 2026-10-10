package com.fathy.alfred.backend.board.domain.model;

/** Why a card was closed: an expected behaviour, not part of this flow, or a real issue not worth fixing. */
public enum Resolution {
    FINE, NOT_IN_FLOW, WONT_FIX
}
