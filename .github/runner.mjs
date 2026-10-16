const HOSTED = 'ubuntu-latest';
const QUEUE = `query($o:String!,$n:String!,$b:String!){repository(owner:$o,name:$n){mergeQueue(branch:$b){entries(first:100){nodes{position headCommit{oid} pullRequest{number isCrossRepository}}}}}}`;

export async function decide({ context, github, env }) {
  if (env.FORCED) return { runner: env.FORCED, why: 'vars.CI_RUNNER' };
  const pool = env.POOL || HOSTED;
  const { owner, repo } = context.repo;
  if (context.eventName === 'pull_request') {
    const head = context.payload.pull_request.head.repo;
    const same = head && head.full_name === `${owner}/${repo}`;
    return same ? { runner: pool, why: 'same-repo PR' } : { runner: HOSTED, why: 'fork PR' };
  }
  if (context.eventName === 'merge_group') {
    const group = context.payload.merge_group;
    const base = group.base_ref.replace('refs/heads/', '');
    const q = await github.graphql(QUEUE, { o: owner, n: repo, b: base });
    const entries = q.repository.mergeQueue?.entries?.nodes ?? [];
    const own = entries.find((e) => e.headCommit?.oid === group.head_sha);
    if (!own) return { runner: HOSTED, why: 'merge group not found in the queue' };
    const members = entries.filter((e) => e.position <= own.position);
    const forks = members.filter((e) => e.pullRequest?.isCrossRepository !== false);
    return forks.length === 0
      ? { runner: pool, why: `merge group of ${members.length} same-repo entries` }
      : {
          runner: HOSTED,
          why: `merge group with a fork or unknown PR: ${forks.map((e) => e.pullRequest?.number).join(', ')}`,
        };
  }
  return { runner: HOSTED, why: context.eventName };
}
