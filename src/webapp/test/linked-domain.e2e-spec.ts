import { Test, TestingModule } from '@nestjs/testing'
import { SettingsModule } from '../src/settings/settings.module'
import { TypeOrmModule } from '@nestjs/typeorm'
import { GraphQLModule } from '@nestjs/graphql'
// import { INestApplication } from '@nestjs/common'
import { Connection } from 'typeorm'
import { NestExpressApplication } from '@nestjs/platform-express'
import * as request from 'supertest'
import { ConfigModule } from '@nestjs/config'
// import { ExtractJwt } from 'passport-jwt'

// import { AppModule } from './../src/app.module'
import { DB_CONFIG } from './config'
import { configureApp } from '../src/main.app'
import { AppService } from '../src/app.service'
import { AuthModule } from '../src/auth/auth.module'
import { ValidatorModule } from '../src/validator/validator.module'
import { AccountsModule } from '../src/accounts/accounts.module'
import { ApiV1AutheticationController } from '../src/api/controllers/v1/api.authentication.controller'
import { StripeService } from '../src/payments/services/stripe.service'

import jwt_decode from 'jwt-decode'
import { GoogleOAuth2Service } from '../src/auth/google.service'
import { CronService } from '../src/cron/cron.service'

// const keys = {
//   jwt_private_key: '-----BEGIN PRIVATE KEY-----nMIGEAgEAMBAGByqGSM49AgEGBSuBBAAKBG0wawIBAQQgxjRaB1myLLnts/gMj3sPnwwlnF9BxLF86108qAH4g5zqhRANCAAQfUj/9Q1zJBqw+HX0e37+fHo9BoU4sE6MbnE4yKeEua8pncGu53WWZ6ExJ2Ohnf5gPYRoj3f1z3utCDjADPuFSOn-----END PRIVATE KEY-----n',
//   jwt_public_key: '-----BEGIN PUBLIC KEY-----nMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEH1I//UNcyQasPh19Ht+/nx6PQaFOLBOjnGxOMinhLmvKZ3Brud1lmehMSdjoZ3+YD2EaI939c97rQg4wAz7hUjg==n-----END PUBLIC KEY-----n'
// }

/**
 * User: 101
 * Account: 201 => users 101
 * AccountDomains => 301 => account 201
 */
const DB_INIT: string = `
TRUNCATE accounts;
TRUNCATE accounts_users;
TRUNCATE users;
TRUNCATE users_credentials;
TRUNCATE plans;
TRUNCATE payments;
TRUNCATE settings;

INSERT INTO settings VALUES (1,'website','{"name": "Uplom", "domain_primary": "uplom.com"}', NOW(), NOW());
INSERT INTO users (id, email, password, isAdmin, isActive, emailConfirmationToken, resetPasswordToken,data) VALUES (101,'admin@uplom.com','password',1,1,1,1,'{"profile":{}}');
INSERT INTO accounts (id, owner_id, data) VALUES (201, 101, '{}');
INSERT INTO accounts_users (account_id, user_id) VALUES (201, 101);
INSERT INTO users_credentials (credential, userId, json) VALUES ('admin@uplom.com',101,'{"encryptedPassword": "$2b$12$lQHyC/s1tdH1kTwrayYyUOISPteINC5zbHL2eWL6On7fMtIgwYdNm"}');
INSERT INTO accounts_domains (id, domain, data) VALUES (301, 'uplom.com', '{"account_id": 201}')
`

const newUser = 'email=new@uplom.com&password=password'
const newUserNotLinked = 'email=new@anotherdomain.com&password=password'

let agent: any

jest.setTimeout(1000 * 60 * 10)

const configuration = (): any => ({
  port: 1234
})

// const envFile = '../env/env.local'
// const secretsFile = '../env/secrets.local'

describe('Authentication (e2e)', () => {
  let app: NestExpressApplication
  // let settingsService: SettingsService

  const mockedStripe = {
    client2: {},
    client: {
      customers: {
        retrieve: jest.fn(_ => {
          return ({
            subscriptions: {
              data: [
                { id: 'sub_2', status: 'active', active: 'false' },
                { id: 'sub_3', status: 'active', active: 'true' }
              ]
            }
          })
        }),
        create: jest.fn(_ => {
          return ({
          })
        }),
        update: jest.fn(_ => {})
      },
      paymentMethods: {
        attach: jest.fn(_ => {})
      },
      products: {
        create: jest.fn(_ => {})
      },
      prices: {
        create: jest.fn(_ => {})
      }
    }
  }

  const GOOGLE_ID_TOKEN_TO_SIGNIN = 'BAMBIIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtWbXJpxrTjMiAlmxHxDvBCO7knjP8xw7/se17BvUvLtaDsPSg7CC6Nh6FYSuLMDOiHNlXJTs43b8bepGAzvhB4kt2SUX//JsysI1wspCSnqblapX'
  const GOOGLE_ID_TOKEN_TO_SIGNUP = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtWbXJpxrTjMiAlmxHxDvBCO7knjP8xw7/se17BvUvLtaDsPSg7CC6Nh6FYSuLMDOiHNlXJTs43b8bepGAzvhB4kt2SUX//JsysI1wspCSnqblapX'
  const GOOGLE_ID_TOKEN_TO_ERROR = 'QQER2jANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtWbXJpxrTjMiAlmxHxDvBCO7knjP8xw7/se17BvUvLtaDsPSg7CC6Nh6FYSuLMDOiHNlXJTs43b8bepGAzvhB4kt2SUX//JsysI1wspCSnqblapX'

  const mockedGoogle = {
    getUserPayload: jest.fn((token) => {
      let res = {}
      if (token === GOOGLE_ID_TOKEN_TO_SIGNIN) {
        res = { email: 'user@gmail.com', sub: '21042432312123123' }
      }
      if (token === GOOGLE_ID_TOKEN_TO_SIGNUP) {
        res = { email: 'admin@uplom.com', sub: '21011211912123123' }
      }
      if (token === GOOGLE_ID_TOKEN_TO_ERROR) {
        res = { email: 'mi@gmail.com', sub: '21011218888823123' }
      }
      return res
    })
  }

  const mockedCronService = {
    setupCron: jest.fn(_ => {})
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(DB_CONFIG),
        GraphQLModule.forRoot({
          playground: true,
          installSubscriptionHandlers: true,
          autoSchemaFile: true
        }),
        ConfigModule.forRoot({
          // envFilePath: [secretsFile, envFile],
          load: [configuration],
          isGlobal: true
        }),
        AuthModule,
        SettingsModule,
        AccountsModule,
        ValidatorModule
      ],
      controllers: [ApiV1AutheticationController],
      providers: [
        AppService,
        {
          provide: StripeService,
          useValue: mockedStripe
        },
        {
          provide: GoogleOAuth2Service,
          useValue: mockedGoogle
        },
        { provide: CronService, useValue: mockedCronService }
      ]
    })
      .overrideProvider(StripeService).useValue(mockedStripe)
      .compile()

    app = moduleFixture.createNestApplication()
    configureApp(app, true)
    await app.init()

    const db = app.get(Connection)
    let query: string
    for (query of DB_INIT.split(';')) {
      if (query.trim() !== '') {
        await db.query(query)
      }
    }

    agent = await request(app.getHttpServer())
  })

  afterAll(async () => {
    await app.close()
  })

  it('register new user with linked domain', done => {
    return agent
      .post('/api/v1/login')
      .send(newUser)
      .expect(401)
      .then(_ =>
        agent
          .post('/api/v1/signup')
          .send(newUser)
          .expect(302)
          .then(_ =>
            agent
              .post('/api/v1/login')
              .send(newUser)
              .expect(302)
              .expect(res => {
                const jwt = res.headers['set-cookie'][0]
                  .split('=')[1]
                  .split(' ')[0]
                try {
                  const { iat, ...decoded } = jwt_decode(jwt) as any //eslint-disable-line

                  expect(decoded).toEqual({
                    account_id: 201,
                    account_name: '',
                    email: 'new@uplom.com',
                    email_verified: false,
                    id: 102,
                    nonce: '',
                    staff: false,
                    status: 'active',
                    user_email: 'new@uplom.com',
                    username: ''
                  })
                  return done()
                } catch (err) {
                  console.log('err', err)
                  return done(err)
                }
              })
          )
      )
  })

  it('register new user with domain not linked', done => {
    return agent
      .post('/api/v1/login')
      .send(newUserNotLinked)
      .expect(401)
      .then(_ =>
        agent
          .post('/api/v1/signup')
          .send(newUserNotLinked)
          .expect(302)
          .then(_ =>
            agent
              .post('/api/v1/login')
              .send(newUserNotLinked)
              .expect(302)
              .expect(res => {
                const jwt = res.headers['set-cookie'][0]
                  .split('=')[1]
                  .split(' ')[0]
                try {
                const { iat, ...decoded } = jwt_decode(jwt) as any //eslint-disable-line

                  expect(decoded).toEqual({
                    account_id: 202,
                    account_name: 'new@anotherdomain.com',
                    email: 'new@anotherdomain.com',
                    email_verified: false,
                    id: 103,
                    nonce: '',
                    staff: false,
                    status: 'active',
                    user_email: 'new@anotherdomain.com',
                    username: ''
                  })
                  return done()
                } catch (err) {
                  console.log('err', err)
                  return done(err)
                }
              })
          )
      )
  })
})
