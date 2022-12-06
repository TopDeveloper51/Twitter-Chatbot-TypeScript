import { ChatGPTAPI } from 'chatgpt'
import delay from 'delay'
import { Client as TwitterClient, auth } from 'twitter-api-sdk'
import { TwitterApi } from 'twitter-api-v2'

import * as types from './types'
import config from './config'
import { respondToNewMentions } from './respond-to-new-mentions'
import { maxTwitterId } from './twitter'

async function main() {
  const dryRun = !!process.env.DRY_RUN
  const earlyExit = !!process.env.EARLY_EXIT
  const debugTweet = process.env.DEBUG_TWEET
  const defaultSinceMentionId = process.env.SINCE_ID
  const defaultRefreshToken = process.env.TWITTER_TOKEN
  const tweetMode: types.TweetMode =
    (process.env.TWEET_MODE as types.TweetMode) || 'image'
  const forceReply = !!process.env.FORCE_REPLY

  const chatgpt = new ChatGPTAPI({
    sessionToken: process.env.SESSION_TOKEN!,
    markdown: tweetMode === 'image' ? true : false
  })

  // for testing chatgpt
  // await chatgpt.ensureAuth()
  // const res = await chatgpt.sendMessage('this is a test')
  // console.log(res)
  // return

  let sinceMentionId = defaultSinceMentionId || config.get('sinceMentionId')

  const refreshToken = defaultRefreshToken || config.get('refreshToken')
  // const refreshToken = config.get('refreshToken')
  const authToken = refreshToken ? { refresh_token: refreshToken } : undefined
  const authClient = new auth.OAuth2User({
    client_id: process.env.TWITTER_CLIENT_ID,
    client_secret: process.env.TWITTER_CLIENT_SECRET,
    callback: 'http://127.0.0.1:3000/callback',
    scopes: ['tweet.read', 'users.read', 'offline.access', 'tweet.write'],
    token: authToken
  })

  async function refreshTwitterAuthToken() {
    console.log('refreshing twitter access token')
    try {
      const { token } = await authClient.refreshAccessToken()
      config.set('refreshToken', token.refresh_token)
      return token
    } catch (err) {
      console.error('unexpected error refreshing twitter access token', err)
      return null
    }
  }

  await refreshTwitterAuthToken()

  // Twitter API v2 using OAuth 2.0
  const twitter = new TwitterClient(authClient)

  // Twitter API v1 using OAuth 1.1a?
  // NOTE: this is required only to upload media since that doesn't seeem to be
  // supported with the Twitter API v2
  const twitterApi = new TwitterApi({
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET_KEY,
    accessToken: process.env.TWITTER_API_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_API_ACCESS_SECRET
  })
  const { v1: twitterV1 } = twitterApi

  const { data: user } = await twitter.users.findMyUser()

  if (!user?.id) {
    throw new Error('twitter error unable to fetch current user')
  }
  // console.log(user)
  // console.log(await twitterApi.currentUser())
  // return

  await chatgpt.ensureAuth()

  let interactions: types.ChatGPTInteraction[] = []
  let loopNum = 0
  do {
    try {
      console.log()
      const session = await respondToNewMentions({
        dryRun,
        earlyExit,
        forceReply,
        debugTweet,
        chatgpt,
        twitter,
        twitterV1,
        user,
        sinceMentionId,
        tweetMode
      })

      if (session.sinceMentionId) {
        sinceMentionId = maxTwitterId(sinceMentionId, session.sinceMentionId)

        // Make sure it's in sync in case other processes are writing to the store
        // as well. Note: this still has a classic potential as a race condition,
        // but it's not enough to worry about for our use case.
        const recentSinceMentionId = config.get('sinceMentionId')
        sinceMentionId = maxTwitterId(sinceMentionId, recentSinceMentionId)

        if (sinceMentionId && !dryRun) {
          config.set('sinceMentionId', sinceMentionId)
        }
      }

      if (earlyExit) {
        break
      }

      console.log(
        `processed ${session.interactions?.length ?? 0} interactions`,
        session.interactions
      )
      if (session.interactions?.length) {
        interactions = interactions.concat(session.interactions)
      }

      if (debugTweet) {
        break
      }

      if (session.isExpiredAuth) {
        throw new Error(
          'ChatGPT auth expired error; unrecoverable. Please update SESSION_TOKEN'
        )
        break
      }

      if (session.isRateLimited || session.isRateLimitedTwitter) {
        console.log(
          `rate limited ${
            session.isRateLimited ? 'chatgpt' : 'twitter'
          }; sleeping...`
        )
        await delay(30000) // 30s
        await delay(30000) // 30s

        if (session.isRateLimitedTwitter) {
          console.log('sleeping longer for twitter rate limit...')
          await delay(5 * 60 * 1000) // 5m
        }
      }

      const validSessionInteractions = session.interactions.filter(
        (interaction) =>
          !interaction.error && interaction.responseTweetIds?.length
      )

      if (!validSessionInteractions?.length) {
        console.log('sleeping...')
        // sleep if there were no mentions to process
        await delay(30000) // 30s
      } else {
        // still sleep if there are active mentions because of rate limits...
        await delay(5000) // 5s
      }

      ++loopNum

      if (session.isExpiredAuthTwitter || loopNum % 20 === 0) {
        await refreshTwitterAuthToken()
      }
    } catch (err) {
      console.error(
        'top-level error',
        err,
        err.error?.errors ? JSON.stringify(err.error.errors, null, 2) : ''
      )
      await delay(30000)
      await refreshTwitterAuthToken()
    }
  } while (true)

  return interactions
}

main()
  .then((res) => {
    if (res?.length) {
      console.log(res)
    }
    process.exit(0)
  })
  .catch((err) => {
    console.error('error', JSON.stringify(err, null, 2))
    process.exit(1)
  })
