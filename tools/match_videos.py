"""Match one YouTube form video to every exercise in data/exercises.csv.

Scrapes YouTube search results (public HTML, no API key), scores candidates
by channel reputation / title relevance / sane duration, and writes the pick
back into the CSV. Incremental saves; safe to re-run — skips filled rows.

Usage: python tools/match_videos.py [max_rows]
"""
import csv, json, re, sys, time, random, threading, urllib.request, urllib.parse

CSV_PATH = 'data/exercises.csv'
THREADS = 3
GOOD_CHANNELS = [
    'squat university', 'athlean', 'jeff nippard', 'renaissance periodization',
    'calisthenicmovement', 'hybrid calisthenics', 'scott herman', 'buff dudes',
    'testosterone nation', 'physique development', 'mobility doc', 'bob & brad',
    'e3 rehab', 'prehab', 'muscle & motion', 'livestrong', 'howcast',
    'bodybuilding.com', 'mind pump', 'fitness blender', 'ace fitness',
    'nuffield health', 'puregym', 'planet fitness', 'la fitness', 'my pt hub',
    'exercise library', 'gymvisual', 'coach', 'physio', 'strength',
]
TITLE_WORDS = ['how to', 'form', 'tutorial', 'technique', 'guide', 'properly', 'demo']
STOP = {'the', 'a', 'with', 'and', 'or', 'of', 'on', 'in', 'to', 'for'}

def fetch(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9'})
    return urllib.request.urlopen(req, timeout=20).read().decode('utf-8', 'ignore')

def parse_len(t):
    p = t.split(':')
    try:
        if len(p) == 2: return int(p[0]) * 60 + int(p[1])
        if len(p) == 3: return int(p[0]) * 3600 + int(p[1]) * 60 + int(p[2])
    except ValueError: pass
    return 0

def candidates(query):
    html = fetch('https://www.youtube.com/results?search_query=' + urllib.parse.quote(query))
    m = re.search(r'var ytInitialData = ({.*?});</script>', html)
    if not m: return []
    out = []
    def walk(o):
        if isinstance(o, dict):
            if 'videoRenderer' in o:
                v = o['videoRenderer']
                out.append({
                    'id': v.get('videoId', ''),
                    'title': ''.join(r.get('text', '') for r in v.get('title', {}).get('runs', [])),
                    'channel': ''.join(r.get('text', '') for r in v.get('ownerText', {}).get('runs', [])),
                    'secs': parse_len(v.get('lengthText', {}).get('simpleText', '0:00')),
                })
            for x in o.values(): walk(x)
        elif isinstance(o, list):
            for x in o: walk(x)
    walk(json.loads(m.group(1)))
    return [c for c in out if c['id']][:10]

def score(c, name):
    s = 0.0
    ch = c['channel'].lower(); ti = c['title'].lower()
    if any(g in ch for g in GOOD_CHANNELS): s += 3
    s += 2 * sum(1 for w in TITLE_WORDS if w in ti) / len(TITLE_WORDS) * 3
    toks = [t for t in re.findall(r'[a-z0-9]+', name.lower()) if t not in STOP]
    if toks:
        s += 3 * sum(1 for t in toks if t in ti) / len(toks)
    if 20 <= c['secs'] <= 480: s += 1.5
    elif c['secs'] > 900: s -= 1
    return s

def main():
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else 10 ** 9
    rows = list(csv.DictReader(open(CSV_PATH, encoding='utf-8')))
    fields = rows[0].keys()
    todo = [r for r in rows if not r.get('YouTubeVideoID')]
    # seed exercises first, then beginner home stuff, then the rest
    todo.sort(key=lambda r: (0 if r['ExerciseID'].startswith('EX') else
                             1 if r['Difficulty'] == 'Beginner' else
                             2 if r['Difficulty'] == 'Intermediate' else 3))
    todo = todo[:limit]
    print(f'{len(todo)} rows to match', flush=True)

    lock = threading.Lock()
    done = [0]

    def save():
        with open(CSV_PATH, 'w', newline='', encoding='utf-8') as f:
            w = csv.DictWriter(f, fieldnames=fields, lineterminator='\n')
            w.writeheader(); w.writerows(rows)

    def work(chunk):
        for r in chunk:
            try:
                cands = candidates(r['ExerciseName'] + ' exercise proper form')
                if cands:
                    best = max(cands, key=lambda c: score(c, r['ExerciseName']))
                    if score(best, r['ExerciseName']) >= 2.0:
                        with lock:
                            r['YouTubeVideoID'] = best['id']
                            r['PreferredVideoURL'] = 'https://www.youtube.com/watch?v=' + best['id']
                            r['EmbedURL'] = 'https://www.youtube-nocookie.com/embed/' + best['id']
                            r['SourceType'] = 'YouTube: ' + best['channel'][:60]
            except Exception as ex:
                print('ERR', r['ExerciseID'], type(ex).__name__, flush=True)
                time.sleep(5)
            with lock:
                done[0] += 1
                if done[0] % 25 == 0:
                    save(); print(f'{done[0]}/{len(todo)}', flush=True)
            time.sleep(random.uniform(1.2, 2.4))

    chunks = [todo[i::THREADS] for i in range(THREADS)]
    threads = [threading.Thread(target=work, args=(c,)) for c in chunks]
    for t in threads: t.start()
    for t in threads: t.join()
    save()
    matched = sum(1 for r in rows if r.get('YouTubeVideoID'))
    print(f'DONE. matched total: {matched}/{len(rows)}', flush=True)

if __name__ == '__main__':
    main()
