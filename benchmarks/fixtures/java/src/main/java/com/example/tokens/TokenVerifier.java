package com.example.tokens;

public class TokenVerifier {
  public boolean verify(String token) {
    return token != null && token.length() > 8;
  }
}
