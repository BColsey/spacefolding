package com.example;

import com.example.tokens.TokenVerifier;

public class AuthController {
  private final TokenVerifier verifier = new TokenVerifier();

  public boolean authenticateRequest(String token) {
    return verifier.verify(token);
  }
}
