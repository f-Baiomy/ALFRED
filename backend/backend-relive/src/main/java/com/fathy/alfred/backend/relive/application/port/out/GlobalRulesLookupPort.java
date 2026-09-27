package com.fathy.alfred.backend.relive.application.port.out;

import java.util.List;

/** Outbound port to backend-interception's rule list, via an APP bridge (T015). */
public interface GlobalRulesLookupPort {

    List<GlobalRuleRef> list();

    boolean exists(String id);
}
