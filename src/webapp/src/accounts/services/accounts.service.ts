import { REQUEST } from '@nestjs/core'
import { Injectable, Inject } from '@nestjs/common'
import { QueryService } from '@nestjs-query/core'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import { AccountEntity, AccountData } from '../entities/account.entity'

import { ConfigService } from '@nestjs/config'
import { ValidationService } from '../../validator/validation.service'

import { UsersService } from './users.service'
import { UserEntity } from '../entities/user.entity'
import { AccountsUsersService } from './accountsUsers.service'
import { AccountsDomainsService } from './accountsDomains.service'
import { BaseService } from '../../utilities/base.service'
import { NotificationsService } from '../../notifications/notifications.service'
import { SettingsService } from '../..//settings/settings.service'
import { PaymentsService } from '../../payments/services/payments.service'
import { PlansService } from '../../payments/services/plans.service'
import { UserJson } from '../dto/new-user.input'

@QueryService(AccountEntity)
@Injectable()
export class AccountsService extends BaseService<AccountEntity> {
  private readonly paymentIntegration: string

  constructor (
    @Inject(REQUEST) private readonly req: any,
    @InjectRepository(AccountEntity)
    private readonly accountsRepository: Repository<AccountEntity>,
    private readonly accountsUsersService: AccountsUsersService,
    private readonly usersService: UsersService,
    private readonly accountsDomainsService: AccountsDomainsService,
    private readonly paymentsService: PaymentsService,
    private readonly plansService: PlansService,
    private readonly notificationService: NotificationsService,
    private readonly settingsService: SettingsService,
    private readonly configService: ConfigService,
    private readonly validationService: ValidationService
  ) {
    super(req, 'AccountEntity')
    this.paymentIntegration = this.configService.get<string>('MODULE_PAYMENT', 'stripe')
  }

  async getAll (): Promise<AccountEntity[]> {
    const accounts = await this.accountsRepository.find()

    return accounts
  }

  async findByOwnerEmail (email: string): Promise<AccountEntity> {
    const user = await this.accountsUsersService.findUserByEmail(email)
    const _result = await this.query({ filter: { owner_id: { eq: user.id } } })

    return _result[0]
  }

  async getOwner (id: number): Promise<UserEntity | null> {
    try {
      const account = await this.findById(id)
      if (account == null) {
        console.error('accountsService - returnOwner - account not found')
        return null
      }

      const owner = await this.usersService.findById(account.owner_id)
      if (owner == null) {
        console.error('accountsService - returnOwner - owner not found')
        return null
      }

      return owner
    } catch (error) {
      console.error('accountsService - returnOwner - exception', error, id)
      return null
    }
  }

  /**
   * Return the account that is linked to an email domain, if it exists. Null otherwise.
   * For instance if a company links the domain "@company.com" every email @company.com
   * will return the company account
   *
   * @param email an email to search
   * @returns the account or null
   */
  async getAccountByEmailDomain (email: string): Promise<AccountEntity|null> {
    const domain = email.split('@')[1]
    const accountId = await this.accountsDomainsService.getAccountIsByEmailDomain(domain)
    if (accountId == null) {
      console.error('accountsService - getAccountByEmailDomain - cannot find account for the domain', domain)
      return null
    }

    const account = await this.findById(accountId)

    if (account == null) {
      // this should never happend
      console.error('accountsService - getAccountByEmailDomain - cannot find account for the accountId', domain, accountId)
      return null
    }

    return account ?? null
  }

  /**
   * Link a domain to an account _and_ mark the email verification to true
   *
   * @param id Id of the account to link
   * @param domain domain to link
   * @returns the linked account or null
   */
  async linkDomain (id: number, domain: string): Promise<AccountEntity | null> {
    const account = await this.findById(id)
    if (account == null) {
      console.error('accountsService - linkDomain - cannot find account', id)
      return null
    }

    if (await this.accountsDomainsService.link(domain, account.id) == null) {
      console.error('accountsService - linkDomain - cannot link account', id)
      return null
    }

    try {
      account.data.email_verification_required = true
      await this.updateOne(account.id, { data: account.data })

      return account
    } catch (err) {
      console.error(
        'accounts.service - linkDomain - Error while setting email_verification_required to true',
        id,
        err
      )

      await this.accountsDomainsService.unlink(domain)

      return null
    }
  }

  /**
   * Add an account and set the user as owner or attach the user
   * to the corresponding account, if the domain is linked.
   *
   * If the domain of the user's email is linked, add the user to the account.
   * Else, create a new account
   *    Create a stipe user and add to the account
   *    If a user is specified, add such user as owner (to remove?)
   *
   * @param data data of the account
   * @param user data of the account owner
   * @returns the account created or attached or null
   */
  async addOrAttach ({ data, user }): Promise<AccountEntity | null> {
    let account
    if (user?.email != null && (account = await this.getAccountByEmailDomain(user.email)) != null) {
      // attach user to account
      if (user !== undefined) await this.accountsUsersService.addUser(user, account)

      return account
    } else {
      // Create an account
      account = new AccountEntity()
      account.data = new AccountData()
      account.data.name = data.name

      // If no user was passed, we add 0 as owner_id.
      // This will be overwritten later when the first user
      // will be associated with this account.
      account.owner_id = user?.id ?? 0

      // Create a Billing user for this account
      const billingCustomers = await this.paymentsService.createBillingCustomer({
        name: data.name
      })
      // TODO: stripeCustomer might be null if Stripe is not configure.
      // at the moment it fails gracefully, but we should write a more
      // proper way.

      account.data.stripe = billingCustomers[0]
      if (this.paymentIntegration === 'killbill') {
        account.data.killbill = billingCustomers[1]
      }

      // Add free tier plan
      try {
        const plans = await this.plansService.getPlans()
        await this.paymentsService.createFreeSubscription(
          plans[0],
          (this.paymentIntegration === 'killbill' ? account.data.killbill.accountId : account.data.stripe.id)
        )
      } catch (err) {
        console.error('accountsService - cannot create free subscription')
      }

      try {
        const res = await this.createOne(account)
        // If a user is specified add the user as owner
        if (user !== undefined) await this.accountsUsersService.addUser(user, res)
        // TODO: refactor this

        // send email here (new account template)
        const emailData = {
          user,
          action_url: `${await this.settingsService.getBaseUrl()}/verify-email/${user.emailConfirmationToken as string}`
        }

        if ((await this.notificationService.sendEmail(user.email, 'email_confirm', emailData)) === false) {
          console.error('Error while sending email')
        }

        return res
      } catch (err) {
        console.error('Error while inserting new account', data, user, err)
        return null
      }
    }
  }

  /**
   * Get users of a given account
   * @param id Id of the account to search
   */
  async getUsers (id: number): Promise<Array<UserEntity | undefined>> { // TODO: fix undefined return value. It should be null
    // 1. get users id from accountUsers table
    const usersIds = await this.accountsUsersService.query({
      filter: { account_id: { eq: id } }
    })

    // 2. get all info for each user
    const users = await Promise.all(
      usersIds.map(async u =>
        await this.usersService.findById(u.user_id)
      )
    )
    if (users == null) {
      // No users for account. This should never happend
      return []
    }

    return users.filter(u => u != null)
  }

  async setOwner (account: AccountEntity, userId: number): Promise<any> {
    // Setting owner if not already set.
    // This is useful for the creation of the first user.
    if (account.owner_id === 0) {
      try {
        await this.updateOne(account.id, { owner_id: userId })
      } catch (err) {
        console.error(
          'accounts.service - inviteUser - Error while inviting new user (setting owner)',
          err
        )
        return null
      }
    }
  }

  /**
   * Invite a user.
   *
   * Create a new user and reset its password.
   * Then add it to the accountUser model.
   *
   * @param userInput data of the user to invite
   * @param accountId id of the account to add the user to
   */
  async inviteUser (userInput: UserJson, accountId: number): Promise<UserEntity | null> { // TODO: specify type
    if (userInput == null) {
      return null
    }

    // Get account
    const account = await this.findById(accountId)
    if (account == null) {
      console.error('accounts.service - inviteUser - account not found')
      return null
    }

    const user = await this.usersService.findOrCreateUser(userInput)
    if (user == null) {
      return null
    }

    // TODO: can it be possible that an invited user is the owner?
    // maybe yes if it is invited by the saas admin
    await this.setOwner(account, user.id)

    if (await this.accountsUsersService.addUser(user, account) == null) {
      console.error(
        'accounts.service - inviteUser - Error while inviting new user (add accountUser relationthip)', user.id, account.id
      )
      return null
    }

    // send email here (invited user template)
    const emailData = {
      account,
      user,
      // TODO #98
      sender: {
        display_name: account.data.name
      },
      action_url: `${await this.settingsService.getBaseUrl()}/reset-password/${user.resetPasswordToken}`
    }
    if (await this.notificationService.sendEmail(user.email, 'user_invite', emailData) === false) {
      console.error('accountsService - inviteUser - error while sending email')
    }

    return user
  }

  async findByUserId (userId): Promise<AccountEntity | undefined> {
    const users = await this.accountsUsersService.query({
      filter: { user_id: { eq: userId } }
    })
    const account = await this.findById(users[0]?.account_id)

    return account
  }

  async deleteUser (userId: number): Promise<Boolean> {
    // TODO: implement this
    return true
  }

  /**
   * Create a payment method and attach to an account.
   * This SHOULD NOT be used anymore since it requires the credit card data ad input
   * and is considered unsafe. Use addPaymentsMethods instead
   * @param id the id of the account
   * @param card information about the credit card
   */
  async createPaymentsMethods (id: number, card: any): Promise<[any]|any> {
    // DEPRECATED
    try {
      const account = await this.findById(id)
      if (account == null) {
        console.error('addPaymentsMethods - account not found')
        return null
      }
      if (account.data == null) {
        console.error('addPaymentsMethods - account format error')
        return null
      }

      const method = await this.paymentsService.createPaymentMethod(account.data.stripe.id, card)

      return await this.addPaymentsMethods(id, method)
    } catch (error) {
      console.error('getPaymentsMethods - error', id, error)
    }
  }

  /**
   * Add a Stripe payment method to an account. Note that the payment method should be created elsewhere, possibly on the client.
   * @param id id of the account
   * @param method paymentMethod to add as returned by Stripe
   */
  async addPaymentsMethods (id: number, method: any): Promise<[any]|null> { // TODO: fix return type
    try {
      const account = await this.findById(id)
      if (account == null) {
        console.error('accountsService - addPaymentsMethods - account not found')
        return null
      }
      if (account.data == null) {
        console.error('accountsService - addPaymentsMethods - account format error')
        return null
      }

      const customer = await this.paymentsService.attachPaymentMethod(account, method.id)
      if (customer == null) {
        console.error('accountsService - addPaymentsMethods - error while attaching payment method to customer')
        return null
      }

      if (account.data.payments_methods == null) { account.data.payments_methods = [method] } else { account.data.payments_methods.push(method) }

      if (account.data.payments_methods == null) {
        console.error('accountsService - addPaymentsMethods - error while adding payment method')
        return null
      }

      const updatedAccount = await this.updateOne(id, { data: account.data })
      if (updatedAccount == null) {
        console.error('accountsService - addPaymentsMethods - error while updating account')
        return null
      }

      return account.data.payments_methods
    } catch (error) {
      console.error('getPaymentsMethods - error', id, error)
      return null
    }
  }

  /**
   * Subscribe an account to a plan
   * @param account account to subscribe
   * @param subscription subscription to buy
   */
  // TODO: better specify the type of subscription
  async subscribeToPlan (account: AccountEntity, subscription: any): Promise<any> { // TODO: return a proper type
    const paymentMethod = account.data.payments_methods.filter(p => p?.id === subscription.method)[0]
    const price = await this.plansService.getPriceByProductAndAnnual(subscription.plan, subscription.monthly)
    return await this.paymentsService.subscribeToPlan(account.data.stripe.id, paymentMethod, price)
    // TODO: check errors
  }
}
