package com.alfred.pennyworth.profiles.application.port.in;

public interface DeleteProfileUseCase {

    /** @return true if a profile with this id existed and was deleted. */
    boolean deleteById(String id);
}
