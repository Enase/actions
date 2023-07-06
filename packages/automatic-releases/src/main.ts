import * as core from '@actions/core';
import * as github from '@actions/github';

import type {GetResponseTypeFromEndpointMethod, GetResponseDataTypeFromEndpointMethod} from '@octokit/types';
import {Context} from '@actions/github/lib/context';
import {sync as commitParser} from 'conventional-commits-parser';

import type {
  GitHub,
  GithubCommitType,
  GetReleaseByTagParameters,
  CreateRefParameters,
  ListTagsParameters,
  CreateReleaseParameters,
  GetRefParameters,
  ParsedCommits,
} from './utils';
import {
  getChangelogOptions,
  dumpGitHubEventPayload,
  isBreakingChange,
  generateChangelogFromParsedCommits,
  parseGitTag,
  octokitLogger,
  CreateReleaseResponse,
} from './utils';
import semverValid from 'semver/functions/valid';
import semverRcompare from 'semver/functions/rcompare';
import semverLt from 'semver/functions/lt';
import {uploadReleaseArtifacts} from './uploadReleaseArtifacts';

type Args = {
  repoToken: string;
  automaticReleaseTag: string;
  draftRelease: boolean;
  preRelease: boolean;
  releaseTitle: string;
  files: string[];
};

const getAndValidateArgs = (): Args => {
  const args = {
    repoToken: core.getInput('repo_token', {required: true}),
    automaticReleaseTag: core.getInput('automatic_release_tag', {
      required: false,
    }),
    draftRelease: JSON.parse(core.getInput('draft', {required: true})),
    preRelease: JSON.parse(core.getInput('prerelease', {required: true})),
    releaseTitle: core.getInput('title', {required: false}),
    files: [] as string[],
  };

  const inputFilesStr = core.getInput('files', {required: false});
  if (inputFilesStr) {
    args.files = inputFilesStr.split(/\r?\n/);
  }

  return args;
};

const createReleaseTag = async (client: GitHub, refInfo: CreateRefParameters) => {
  core.startGroup('Generating release tag');
  const friendlyTagName = refInfo.ref.substring(10); // 'refs/tags/latest' => 'latest'
  core.info(`Attempting to create or update release tag "${friendlyTagName}"`);

  try {
    await client.rest.git.createRef(refInfo);
  } catch (err: any) {
    const existingTag = refInfo.ref.substring(5); // 'refs/tags/latest' => 'tags/latest'
    core.info(
      `Could not create new tag "${refInfo.ref}" (${err.message}) therefore updating existing tag "${existingTag}"`,
    );
    await client.rest.git.updateRef({
      ...refInfo,
      ref: existingTag,
      force: true,
    });
  }

  core.info(`Successfully created or updated the release tag "${friendlyTagName}"`);
  core.endGroup();
};

const deletePreviousGitHubRelease = async (client: GitHub, releaseInfo: GetReleaseByTagParameters) => {
  core.startGroup(`Deleting GitHub releases associated with the tag "${releaseInfo.tag}"`);
  try {
    core.info(`Searching for releases corresponding to the "${releaseInfo.tag}" tag`);
    const resp = await client.rest.repos.getReleaseByTag(releaseInfo);

    core.info(`Deleting release: ${resp.data.id}`);
    await client.rest.repos.deleteRelease({
      owner: releaseInfo.owner,
      repo: releaseInfo.repo,
      release_id: resp.data.id,
    });
  } catch (err: any) {
    core.info(`Could not find release associated with tag "${releaseInfo.tag}" (${err.message})`);
  }
  core.endGroup();
};

const generateNewGitHubRelease = async (
  client: GitHub,
  releaseInfo: CreateReleaseParameters,
): Promise<CreateReleaseResponse> => {
  core.startGroup(`Generating new GitHub release for the "${releaseInfo.tag_name}" tag`);

  core.info('Creating new release');
  const resp: CreateReleaseResponse = await client.rest.repos.createRelease(releaseInfo);
  core.endGroup();
  return resp;
};

const searchForPreviousReleaseTag = async (
  client: GitHub,
  currentReleaseTag: string,
  tagInfo: ListTagsParameters,
): Promise<string> => {
  const validSemver = semverValid(currentReleaseTag);
  if (!validSemver) {
    throw new Error(
      `The parameter "automatic_release_tag" was not set and the current tag "${currentReleaseTag}" does not appear to conform to semantic versioning.`,
    );
  }

  type ListTagsResponseDataType = GetResponseDataTypeFromEndpointMethod<typeof client.rest.repos.listTags>;
  const tagListResponse: ListTagsResponseDataType = await client.paginate(
    client.rest.repos.listTags.endpoint.merge(tagInfo),
  );

  const tagList = tagListResponse
    .map((tag) => {
      core.debug(`Currently processing tag ${tag.name}`);
      const semverTag = semverValid(tag.name) || 'not_valid';
      return {
        ...tag,
        semverTag: semverTag,
      };
    })
    .filter((tag) => tag.semverTag !== 'not_valid')
    .sort((a, b) => semverRcompare(a.semverTag, b.semverTag));

  let previousReleaseTag = '';
  for (const tag of tagList) {
    if (semverLt(tag.semverTag, currentReleaseTag)) {
      previousReleaseTag = tag.name;
      break;
    }
  }

  return previousReleaseTag;
};

const getCommitsSinceRelease = async (
  client: GitHub,
  tagInfo: GetRefParameters,
  currentSha: string,
): Promise<GithubCommitType[]> => {
  core.startGroup('Retrieving commit history');

  core.info('Determining state of the previous release');
  let previousReleaseRef;
  core.info(`Searching for SHA corresponding to previous "${tagInfo.ref}" release tag`);
  try {
    await client.rest.git.getRef(tagInfo);
    previousReleaseRef = parseGitTag(tagInfo.ref);
  } catch (err: any) {
    core.info(
      `Could not find SHA corresponding to tag "${tagInfo.ref}" (${err.message}). Assuming this is the first release.`,
    );
    previousReleaseRef = 'HEAD';
  }

  core.info(`Retrieving commits between ${previousReleaseRef} and ${currentSha}`);

  let commits: GithubCommitType[] = [];
  try {
    const resp: GetResponseTypeFromEndpointMethod<typeof client.rest.repos.compareCommits> =
      await client.rest.repos.compareCommits({
        owner: tagInfo.owner,
        repo: tagInfo.repo,
        base: previousReleaseRef,
        head: currentSha,
      });
    core.info(
      `Successfully retrieved ${resp.data.commits.length} commits between ${previousReleaseRef} and ${currentSha}`,
    );
    if (resp && resp?.data?.commits) {
      commits = resp.data.commits;
    }
  } catch (_err) {
    // istanbul ignore next
    core.warning(`Could not find any commits between ${previousReleaseRef} and ${currentSha}`);
  }

  core.debug(`Currently ${commits.length} number of commits between ${previousReleaseRef} and ${currentSha}`);

  core.endGroup();
  return commits;
};

export const getChangelog = async (
  client: GitHub,
  owner: string,
  repo: string,
  commits: GithubCommitType[],
): Promise<string> => {
  const parsedCommits: ParsedCommits[] = [];
  core.startGroup('Generating changelog');

  for (const commit of commits) {
    core.debug(`Processing commit: ${JSON.stringify(commit)}`);
    core.debug(`Searching for pull requests associated with commit ${commit.sha}`);
    const pulls = await client.rest.repos.listPullRequestsAssociatedWithCommit({
      owner: owner,
      repo: repo,
      commit_sha: commit.sha,
    });
    if (pulls.data.length) {
      core.info(`Found ${pulls.data.length} pull request(s) associated with commit ${commit.sha}`);
    }

    const clOptions = await getChangelogOptions();
    const parsedCommitMsg = commitParser(commit.commit.message, clOptions);

    // istanbul ignore next
    if (parsedCommitMsg.merge) {
      core.debug(`Ignoring merge commit: ${parsedCommitMsg.merge}`);
      continue;
    }

    parsedCommitMsg.extra = {
      commit: commit,
      pullRequests: [],
      breakingChange: false,
    };

    parsedCommitMsg.extra.pullRequests = pulls.data.map((pr) => {
      return {
        number: pr.number,
        url: pr.html_url,
      };
    });

    parsedCommitMsg.extra.breakingChange = isBreakingChange({
      body: parsedCommitMsg.body,
      footer: parsedCommitMsg.footer,
    });
    core.debug(`Parsed commit: ${JSON.stringify(parsedCommitMsg)}`);
    parsedCommits.push(parsedCommitMsg);
    core.info(`Adding commit "${parsedCommitMsg.header}" to the changelog`);
  }

  const changelog = generateChangelogFromParsedCommits(parsedCommits);
  core.debug('Changelog:');
  core.debug(changelog);

  core.endGroup();
  return changelog;
};

export const main = async (): Promise<void> => {
  try {
    const args = getAndValidateArgs();
    const context = new Context();

    // istanbul ignore next
    const client: GitHub = github.getOctokit(args.repoToken, {
      baseUrl: process.env['JEST_MOCK_HTTP_PORT']
        ? `http://localhost:${process.env['JEST_MOCK_HTTP_PORT']}`
        : undefined,
      log: {
        debug: (...logArgs) => core.debug(octokitLogger(...logArgs)),
        info: (...logArgs) => core.debug(octokitLogger(...logArgs)),
        warn: (...logArgs) => core.warning(octokitLogger(...logArgs)),
        error: (...logArgs) => core.error(octokitLogger(...logArgs)),
      },
    });

    core.startGroup('Initializing the Automatic Releases action');
    dumpGitHubEventPayload();
    core.debug(`Github context: ${JSON.stringify(context)}`);
    core.endGroup();

    core.startGroup('Determining release tags');
    const releaseTag = args.automaticReleaseTag ? args.automaticReleaseTag : parseGitTag(context.ref);
    if (!releaseTag) {
      throw new Error(
        `The parameter "automatic_release_tag" was not set and this does not appear to be a GitHub tag event. (Event: ${context.ref})`,
      );
    }

    const previousReleaseTag = await searchForPreviousReleaseTag(client, releaseTag, {
      owner: context.repo.owner,
      repo: context.repo.repo,
    });
    core.endGroup();

    const commitsSinceRelease = await getCommitsSinceRelease(
      client,
      {
        owner: context.repo.owner,
        repo: context.repo.repo,
        ref: `tags/${previousReleaseTag}`,
      },
      context.sha,
    );

    const changelog = await getChangelog(client, context.repo.owner, context.repo.repo, commitsSinceRelease);

    if (args.automaticReleaseTag) {
      await createReleaseTag(client, {
        owner: context.repo.owner,
        ref: `refs/tags/${args.automaticReleaseTag}`,
        repo: context.repo.repo,
        sha: context.sha,
      });

      await deletePreviousGitHubRelease(client, {
        owner: context.repo.owner,
        repo: context.repo.repo,
        tag: args.automaticReleaseTag,
      });
    }

    const releaseResponse = await generateNewGitHubRelease(client, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      tag_name: releaseTag,
      name: args.releaseTitle ? args.releaseTitle : releaseTag,
      draft: args.draftRelease,
      prerelease: args.preRelease,
      body: changelog,
    });

    await uploadReleaseArtifacts(
      client,
      {
        owner: context.repo.owner,
        repo: context.repo.repo,
        release_id: releaseResponse.data.id,
      },
      args.files,
    );

    core.debug(`Exporting environment variable AUTOMATIC_RELEASES_TAG with value ${releaseTag}`);
    core.exportVariable('AUTOMATIC_RELEASES_TAG', releaseTag);
    core.setOutput('automatic_releases_tag', releaseTag);
    core.setOutput('release_id', releaseResponse.data.id);
    core.setOutput('upload_url', releaseResponse.data.upload_url);
  } catch (error: any) {
    core.setFailed(error.message);
    throw error;
  }
};
