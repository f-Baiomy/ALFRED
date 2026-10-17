package com.fathy.alfred.backend.teamboards.spi.model;

import java.net.URI;

/** One configured provider account: Azure DevOps organisation, Jira site... Never holds a token. */
public record Connection(String id, String kind, String name, URI baseUrl, Scope scope) {
}
