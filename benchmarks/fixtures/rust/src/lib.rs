use crate::tokens::Token;

pub mod tokens;

pub struct LoginService;

pub fn verify_login(token: Token) -> bool {
    token.value.len() > 8
}
