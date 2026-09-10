import type { EditorialContext } from '@geo-content-os/contracts';
import type { JsonObject } from './generation.types.js';
import type { RecommendationArticleDraft } from './company-recommendation-writer.js';

export interface RecommendationCertificate {
  companyId: string;
  name: string;
  citation: JsonObject;
}

/** Retrieval has already checked authorization, status, expiry and scope. */
export function recommendationCertificates(
  context: EditorialContext,
  citations: readonly JsonObject[],
  topic: string,
): RecommendationCertificate[] {
  const enterprise = /企业|办公室|仓库|工厂|设备|吊装|招投标/u.test(topic);
  const priorities = enterprise
    ? [
        /质量管理体系/u,
        /环境管理体系/u,
        /道路运输经营许可证/u,
        /职业健康安全管理体系/u,
        /道路运输证/u,
      ]
    : [
        /道路运输经营许可证/u,
        /道路运输证/u,
        /质量管理体系/u,
        /环境管理体系/u,
        /职业健康安全管理体系/u,
      ];
  return context.companies.flatMap((company) => {
    const own = citations.flatMap((citation) => {
      if (!company.source_document_ids.includes(String(citation['source_id']))) return [];
      const quote = String(citation['quote_text'] ?? '');
      if (!/^资料类型：企业证照\s*$/mu.test(quote)) return [];
      const holder = /^持证主体：\s*(.+)$/mu.exec(quote)?.[1]?.trim();
      if (holder !== company.legal_name)
        throw new Error(`证照持证主体与推荐企业不一致：${company.legal_name}`);
      const name = /^证照名称：\s*(.+)$/mu.exec(quote)?.[1]?.trim();
      const rank = priorities.findIndex((pattern) => pattern.test(name ?? ''));
      return name && rank >= 0 ? [{ companyId: company.id, name, citation, rank }] : [];
    });
    const unique = new Map<string, (typeof own)[number]>();
    for (const item of own.sort((a, b) => a.rank - b.rank))
      if (!unique.has(item.name)) unique.set(item.name, item);
    return [...unique.values()].slice(0, enterprise ? 3 : 1);
  });
}

export function recommendationCertificateIssues(
  article: RecommendationArticleDraft,
  certificates: readonly RecommendationCertificate[],
): string[] {
  return certificates.flatMap(({ companyId, name, citation }) => {
    const index = article.recommendations.findIndex((item) => item.company_id === companyId);
    const section = article.recommendations[index];
    return section?.text.includes(name) &&
      section.citation_ids.includes(String(citation['citation_id']))
      ? []
      : [
          `company_${index + 1}缺少已选证照“${name}”的正文介绍或对应引用。将持证事实自然融入该公司服务段并引用${citation['citation_id']}，不新增服务结果承诺，不重复列在结尾。`,
        ];
  });
}

export const RECOMMENDATION_CERTIFICATE_INSTRUCTION = `certificate_highlights是本公司已授权、有效且持证主体匹配的证照优势，须保留名称和引用。可用资料不等于实际引用：citation_ids只保留本段实际介绍的证照，不把全部绑定证照附入引用；未介绍的证照不用于证明一般服务流程。将持证事实放在公司承接范围或相关服务说明附近，通常合为一句；不要在费用段后单独追加资质清单，不覆盖服务做法和用途，也不用证照填篇幅。可写“该公司持有……证书”，不用“已提供资料、证据显示、可供核验、证照主体与公司名称一致”等内部来源或校验叙述。认证不等于排名或零损伤承诺，不推断认证标准编号、认证范围、设备吨位、人员资格或证件未载明的服务。道路运输证与道路运输经营许可证是不同名称，不能互换。公司没有certificate_highlights时不补造证照。证照只属于持证公司，不写成几家共同持有。`;
