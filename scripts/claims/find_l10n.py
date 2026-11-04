#!/usr/bin/env python3
"""Candidate legal/privacy promises in translated sources, by pattern family.
  python3 find_l10n.py > out.tsv     (family \t file \t line \t text)"""
import re, subprocess
L = ['ar','de','es','fr','id','it','ja','ko','nl','pl','pt','ru','tr','vi','zh-CN','zh','fa','he','ur','bn']
FAM = {
 'law_claim': r'(?:GDPR|DSGVO|RGPD|RODO|AVG|KVKK|LGPD|HIPAA)[^.<"]{0,60}(?:konform|conform|compatível|compatible|cumple|uyumlu|zgodny|conforme|tuân thủ|sesuai|준수|準拠|合规|符合|совместим|соответств|متوافق|sicher|safe|seguro|sûr)|(?:konform|conforme|zgodny|uyumlu|conform|compatível|compatible|tuân thủ|sesuai|준수|準拠|合规|符合|соответствует|متوافق)[^.<"]{0,40}(?:GDPR|DSGVO|RGPD|RODO|AVG|KVKK|LGPD|HIPAA)',
 'by_design': r'durch (?:sein(?:e)? )?(?:Design|Architektur)|strukturell|por (?:diseño|design|arquitetura|arquitectura)|estruturalmente|estructuralmente|par (?:conception|architecture)|structurellement|strutturalmente|per (?:architettura|progettazione)|by design|structureel|door (?:architectuur|ontwerp)|strukturalnie|z założenia|yapısal olarak|tasarım gereği|về mặt cấu trúc|theo thiết kế|secara struktural|berdasarkan desain|구조적으로|설계상|構造的に|设计上|结构上|структурно|по (?:архитектуре|построению|конструкции)|هيكليًا|بالتصميم',
 'no_tracking': r'kein(?:e)? (?:Tracking|Nachverfolgung)|sin (?:rastreo|seguimiento)|aucun (?:suivi|pistage)|sans (?:suivi|pistage)|sem rastreamento|nessun tracciamento|geen tracking|(?:bez|brak) śledzenia|(?:izleme|takip) yok|không theo dõi|tanpa pelacakan|추적 없음|추적하지 않|トラッキング(?:なし|しません)|追跡なし|不跟踪|无跟踪|无追踪|без отслеживания|никакого отслеживания|بدون تتبع|لا تتبع|Zero[- ]Tracking',
 'no_collection': r'keine (?:Daten(?:erfassung|sammlung)?|Datenerhebung)|sin recopilación de datos|aucune collecte|sem coleta de dados|nessuna raccolta|geen (?:gegevens|data)verzameling|bez zbierania danych|nie zbieramy|veri toplan(?:maz|mıyor)|veri toplama yok|không thu thập|(?:tidak ada|tanpa) pengumpulan data|데이터 수집 없음|수집하지 않|データ収集なし|収集しません|不收集|无数据收集|не собира|لا نجمع|دون جمع',
 'no_data_sent': r'(?:Keine|keine) Daten (?:werden|gehen)|ningún dato (?:se envía|se transmite)|aucune donnée (?:n\'est|n’est) (?:envoyée|transmise)|nenhum dado (?:é|são) enviado|nessun dato viene (?:inviato|trasmesso)|geen (?:gegevens|data) (?:worden|wordt) (?:naar|opgeslagen)|żadne dane nie są (?:wysyłane|zapisywane)|(?:hiçbir|herhangi bir) veri (?:gönderilmez|gönderilmiyor)|không có dữ liệu nào được gửi|tidak ada data yang dikirim|어떤 데이터도|データは一切|不会发送任何数据|никакие данные не (?:отправля|передаю)|لا يتم إرسال أي بيانات',
 'only_requests': r'(?:JavaScript|JS)[^.<]{0,40}(?:und|y|et|e|en|i|ve|và|dan|및|と|和|и|و)\s*CSS',
}
files = subprocess.run(['git','ls-files','--']+[f'{l}/' for l in L]+[f'data/content/{l}/' for l in L]+['js/locales/'],capture_output=True,text=True).stdout.split()
for f in files:
    try: s = open(f, encoding='utf-8').read()
    except Exception: continue
    for n, line in enumerate(s.split('\n'), 1):
        plain = re.sub(r'(?:href|src)="[^"]*"', ' ', line)
        for fam, rx in FAM.items():
            if re.search(rx, plain, re.I):
                txt = re.sub(r'<[^>]+>', ' ', plain).strip()
                print(f'{fam}\t{f}\t{n}\t{txt[:400]}')
