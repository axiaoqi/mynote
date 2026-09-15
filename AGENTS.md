# 项目协作约定

## Git 远程访问

- Git 拉取和推送使用 SSH，不使用 HTTPS，也不要自动回退到 HTTPS。
- 本项目的 `origin` 地址为 `git@github.com:axiaoqi/mynote.git`。
- 使用用户已有的 SSH 配置和凭据，不改写密钥、不关闭主机身份校验。
- 若 SSH 认证失败，说明实际错误并检查配置，不发起 HTTPS 登录流程。
