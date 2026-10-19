package com.fathy.alfred.backend.links.domain.model;

/** On an environment Alfred: "you are STG for board AB#61813 on PC-1" (D36), as the host told it. */
public record EnvAssignment(String hostLinkId, String boardId, String env, String boardName, String project) {
}
