package com.fathy.alfred.backend.interception.domain;

import com.fathy.alfred.backend.interception.domain.model.PatternSafety;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class PatternSafetyTest {

    @ParameterizedTest
    @ValueSource(strings = {"EUR", "\\d{4}-\\d{2}", "(foo|bar)", "<Token>(.*?)</Token>", "(foo|bar)+",
            "a+?", "\\(a+\\)+", "[(a+)]+", "(ab){2}", "(a?)*x"})
    void acceptsPatternsThatRunInLinearOrBoundedTime(String pattern) {
        assertThat(PatternSafety.problems(pattern, true)).isEmpty();
    }

    @ParameterizedTest
    @ValueSource(strings = {"(a+)+", "(a*)*", "(a|aa)+", "(\\w+\\s?)*", "((a+)b)*", "(a{2,})+"})
    void rejectsNestedRepeats(String pattern) {
        assertThat(PatternSafety.problems(pattern, true))
                .anySatisfy(p -> assertThat(p).contains("repeats a group that itself repeats"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"(?<n>x)", "(?P<n>x)"})
    void rejectsNamedGroupsBecauseJavaAndPythonSpellThemDifferently(String pattern) {
        assertThat(PatternSafety.problems(pattern, true)).anySatisfy(p -> assertThat(p).contains("Named groups"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"(?<=x)y", "a++", "(?>x)"})
    void rejectsConstructsTheTwoEnginesTreatDifferently(String pattern) {
        assertThat(PatternSafety.problems(pattern, true)).isNotEmpty();
    }

    @Test
    void rejectsAPatternOverTheLengthCap() {
        assertThat(PatternSafety.problems("a".repeat(501), false)).isNotEmpty();
        assertThat(PatternSafety.problems("a".repeat(500), false)).isEmpty();
    }

    @Test
    void rejectsARegexThatDoesNotCompile() {
        assertThat(PatternSafety.problems("(unclosed", true)).anySatisfy(p -> assertThat(p).contains("does not compile"));
    }

    @Test
    void aLiteralPatternIsNeverParsedAsARegex() {
        // `(a+)+` typed as literal text is just those five characters - nothing to backtrack.
        assertThat(PatternSafety.problems("(a+)+", false)).isEmpty();
        assertThat(PatternSafety.problems("$10.00", false)).isEmpty();
    }

    @Test
    void anEmptyPatternIsRejected() {
        assertThat(PatternSafety.problems("", false)).isNotEmpty();
        assertThat(PatternSafety.problems(null, true)).isNotEmpty();
    }
}
