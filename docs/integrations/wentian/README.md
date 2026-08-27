# 问天GEO连接器

> 状态：`CHG-VIS-002`已批准
> 边界：本目录只描述GEO Content OS侧连接器，不承载问天独立系统产品与开发文档

## GEO侧范围

GEO Content OS只实现：

- 问天导航入口和连接状态页；
- GEO管理员发起项目绑定申请；
- GEO后端申请一次性SSO launch code；
- 把获授权问题集同步为问天不可变快照；
- 后续按独立任务幂等消费问天签名Webhook；T157不包含Webhook。

GEO不得运行问天API、Worker或Provider Adapter，不执行问天数据库迁移，不共享Cookie、数据库、Redis、对象存储或Provider凭证。

## 契约

- [wentian-geo-connector@1](./WENTIAN-GEO-CONNECTOR-CONTRACT.md)
- [GEO连接器部署清单](./GEO-CONNECTOR-DEPLOYMENT.md)

问天完整批准基线保存在独立项目 `wentian/docs/baseline-CHG-VIS-002/`。Git仓库创建后，应把跨仓库引用替换为正式仓库地址和固定版本，不复制问天完整业务文档到GEO仓库。
